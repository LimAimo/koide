"""Provider layer.

`Provider.stream_chat` yields events:
  {"type": "text",               "delta": str}
  {"type": "reasoning",          "delta": str}
  {"type": "tool_call_delta",    "index": int, "id": str|None, "name": str, "args_chunk": str}
  {"type": "tool_call_complete", "id": str, "name": str, "arguments": dict | None, "error": str | None}
  {"type": "finish",             "reason": str}
  {"type": "error",              "message": str, "truncated": bool}

Tool calls are ONLY completed when the provider explicitly reports a finish reason. Arguments are
JSON assembled per tool_call index/id; no text terminator is ever scanned for, so code that happens
to contain "<<<END>>>" or a markdown fence can never end a call early.
"""
from __future__ import annotations

import asyncio
import json
import threading
import urllib.error
import urllib.request
import uuid
from typing import AsyncIterator

PRESETS = {
    "openai": {"endpoint": "https://api.openai.com/v1", "model": "gpt-4.1"},
    "deepseek": {"endpoint": "https://api.deepseek.com/v1", "model": "deepseek-chat"},
    "kimi": {"endpoint": "https://api.moonshot.cn/v1", "model": "kimi-k2-0905-preview"},
    "openrouter": {"endpoint": "https://openrouter.ai/api/v1", "model": "anthropic/claude-sonnet-4.5"},
    "gemini": {"endpoint": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-pro"},
    "ollama": {"endpoint": "http://127.0.0.1:11434/v1", "model": "qwen2.5-coder"},
    "openai_compatible": {"endpoint": "http://127.0.0.1:8000/v1", "model": ""},
    "anthropic": {"endpoint": "https://api.anthropic.com/v1", "model": "claude-sonnet-5"},
    "gemini_native": {"endpoint": "https://generativelanguage.googleapis.com/v1beta", "model": "gemini-2.5-pro"},
    "minimax": {"endpoint": "https://api.minimax.io/v1", "model": "MiniMax-M2"},
    "minimax_cn": {"endpoint": "https://api.minimaxi.com/v1", "model": "MiniMax-M2"},
}
NOT_YET: set = set()      # 所有已列出的服务商类型都已实现
MINIMAX_KINDS = {"minimax", "minimax_cn"}


class _ThinkSplitter:
    """Some OpenAI-compatible gateways (MiniMax without `reasoning_split`, some local/proxy setups) put the
    whole thinking process inline in the `content` stream as a literal <think>...</think> block instead of
    a separate reasoning channel. Split it back out so the UI can show it as collapsible reasoning instead
    of dumping raw <think> tags into the chat as if they were the answer. A no-op when no such tag appears,
    other than briefly holding back the last few characters in case they are the start of a split tag."""
    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.buf = ""
        self.in_think = False

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        self.buf += chunk
        out: list[tuple[str, str]] = []
        while True:
            tag = self.CLOSE if self.in_think else self.OPEN
            idx = self.buf.find(tag)
            if idx == -1:
                keep = len(tag) - 1
                if len(self.buf) > keep:
                    cut = len(self.buf) - keep
                    piece = self.buf[:cut]
                    if piece:
                        out.append(("reasoning" if self.in_think else "text", piece))
                    self.buf = self.buf[cut:]
                break
            before = self.buf[:idx]
            if before:
                out.append(("reasoning" if self.in_think else "text", before))
            self.buf = self.buf[idx + len(tag):]
            self.in_think = not self.in_think
        return out

    def flush(self) -> list[tuple[str, str]]:
        if not self.buf:
            return []
        out = [("reasoning" if self.in_think else "text", self.buf)]
        self.buf = ""
        return out


class ProviderError(Exception):
    pass


class OpenAICompatible:
    """Chat Completions streaming with tool calling. Works for OpenAI, DeepSeek, Kimi, OpenRouter, Gemini's
    compatibility endpoint, Ollama, LM Studio, vLLM and any custom endpoint."""

    def __init__(self, timeout: float = 120.0):
        self.timeout = timeout

    def list_models(self, profile: dict, api_key: str | None) -> list[str]:
        """Return model ids advertised by an OpenAI-compatible /models endpoint."""
        url = profile["endpoint"].rstrip("/") + "/models"
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers.update(profile.get("headers") or {})
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=min(self.timeout, 30)) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except Exception:
                detail = ""
            raise ProviderError(f"HTTP {e.code}: {detail or e.reason}") from e
        except Exception as e:
            raise ProviderError(f"{type(e).__name__}: {e}") from e
        rows = payload.get("data") if isinstance(payload, dict) else None
        ids = [str(x.get("id")) for x in (rows or []) if isinstance(x, dict) and x.get("id")]
        return sorted(dict.fromkeys(ids), key=str.lower)

    @staticmethod
    def _request(profile: dict, api_key: str | None, messages: list, tools: list | None):
        url = profile["endpoint"].rstrip("/") + "/chat/completions"
        body = {"model": profile["model"], "messages": messages, "stream": True}
        body.update({k: v for k, v in (profile.get("sampling") or {}).items() if v is not None})
        mode = profile.get("_reasoning_mode", "auto")
        kind = profile.get("kind", "openai_compatible")
        model = str(profile.get("model") or "").lower()
        if mode in ("on", "off"):
            if kind == "deepseek":
                body["thinking"] = {"type": "enabled" if mode == "on" else "disabled"}
            elif kind == "openrouter":
                body["reasoning"] = {"enabled": mode == "on"}
            elif kind == "gemini":
                # Gemini's OpenAI-compatible endpoint maps reasoning_effort onto thinking controls.
                body["reasoning_effort"] = "high" if mode == "on" else ("minimal" if ("pro" in model or model.startswith("gemini-3")) else "none")
            elif kind == "openai" and (model.startswith(("o1", "o3", "o4", "gpt-5"))):
                body["reasoning_effort"] = "medium" if mode == "on" else "none"
            elif kind in MINIMAX_KINDS:
                # M2.x models keep thinking on regardless; M3 honours "disabled" to skip it.
                body["thinking"] = {"type": "adaptive" if mode == "on" else "disabled"}
        if kind in MINIMAX_KINDS:
            # Ask MiniMax to split thinking into `reasoning_content` instead of dumping a literal
            # <think>...</think> block into the regular `content` stream. This does not toggle
            # thinking itself, only where it is reported.
            body.setdefault("reasoning_split", True)
        # User-specified provider extras are final so uncommon compatible APIs can override the adapter defaults.
        body.update(profile.get("extra_body") or {})
        if tools and profile.get("tool_calling", True):
            body["tools"] = tools
        if kind == "deepseek" and profile.get("_web_search"):
            # DeepSeek's own server-side web search tool — best-effort: DeepSeek does not (yet) document
            # this on their stable /v1/chat/completions endpoint the way OpenAI/xAI do theirs, so this is
            # appended defensively and any rejection from the server just surfaces as a normal HTTP error
            # the person can see and turn the toggle off for.
            body["tools"] = (body.get("tools") or []) + [{"type": "web_search"}]
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers.update(profile.get("headers") or {})
        return urllib.request.Request(url, json.dumps(body).encode("utf-8"), headers, method="POST")

    def _worker(self, req, emit, holder):
        calls: dict[int, dict] = {}
        finished = False
        splitter = _ThinkSplitter()
        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout)
            holder["resp"] = resp
            for raw in resp:
                if holder["stop"]:
                    return
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except ValueError:
                    continue
                if chunk.get("error"):
                    emit({"type": "error", "message": str(chunk["error"])[:500], "truncated": False})
                    return
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        for kind_, piece in splitter.feed(delta["content"]):
                            if piece:
                                emit({"type": kind_, "delta": piece})
                    rc = delta.get("reasoning_content") or delta.get("reasoning")
                    if rc:
                        emit({"type": "reasoning", "delta": rc})
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index", 0)
                        c = calls.setdefault(idx, {"id": None, "name": "", "args": "", "extra_tc": {}, "extra_fn": {}})
                        if tc.get("id"):
                            c["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            c["name"] += fn["name"]
                        chunk_args = fn.get("arguments") or ""
                        c["args"] += chunk_args
                        # Some providers (Gemini's OpenAI-compat layer, notably) attach extra opaque fields
                        # to a tool call — e.g. `thought_signature`, required verbatim on the next request
                        # or the API rejects it. We don't know every vendor's field name, so we round-trip
                        # anything we don't recognise rather than silently dropping it.
                        for k, v in tc.items():
                            if k not in ("index", "id", "type", "function") and v is not None:
                                c["extra_tc"][k] = v
                        for k, v in fn.items():
                            if k not in ("name", "arguments") and v is not None:
                                c["extra_fn"][k] = v
                        emit({"type": "tool_call_delta", "index": idx, "id": c["id"], "name": c["name"],
                              "args_chunk": chunk_args})
                    if choice.get("finish_reason"):
                        finished = True
                        for kind_, piece in splitter.flush():
                            if piece:
                                emit({"type": kind_, "delta": piece})
                        for idx in sorted(calls):
                            c = calls[idx]
                            cid = c["id"] or f"call_{uuid.uuid4().hex[:10]}"
                            try:
                                args = json.loads(c["args"]) if c["args"].strip() else {}
                                err = None if isinstance(args, dict) else "arguments must be a JSON object"
                            except ValueError as e:
                                args, err = None, f"arguments were not valid JSON: {e}"
                            emit({"type": "tool_call_complete", "index": idx, "id": cid, "name": c["name"],
                                  "arguments": args if not err else None, "error": err,
                                  "extra_tc": c["extra_tc"] or None, "extra_fn": c["extra_fn"] or None})
                        calls.clear()
                        emit({"type": "finish", "reason": choice["finish_reason"]})
            if not finished and not holder["stop"]:
                for kind_, piece in splitter.flush():
                    if piece:
                        emit({"type": kind_, "delta": piece})
                emit({"type": "error", "truncated": True,
                      "message": "模型的输出在完成之前就中断了，未完成的工具调用已被丢弃"})
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except Exception:
                detail = ""
            emit({"type": "error", "message": f"HTTP {e.code}: {detail or e.reason}", "truncated": False})
        except Exception as e:
            if not holder["stop"]:
                emit({"type": "error", "message": f"{type(e).__name__}: {e}", "truncated": not finished})

    async def stream_chat(self, profile: dict, api_key: str | None, messages: list, tools: list | None,
                          cancel: asyncio.Event | None = None) -> AsyncIterator[dict]:
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        holder = {"resp": None, "stop": False}
        req = self._request(profile, api_key, messages, tools)

        def emit(ev):
            loop.call_soon_threadsafe(q.put_nowait, ev)

        def run():
            try:
                self._worker(req, emit, holder)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)

        threading.Thread(target=run, daemon=True).start()
        cancel_wait = asyncio.ensure_future(cancel.wait()) if cancel else None
        try:
            while True:
                getter = asyncio.ensure_future(q.get())
                waiters = {getter} | ({cancel_wait} if cancel_wait else set())
                done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done:
                    getter.cancel()
                    return
                ev = getter.result()
                if ev is None:
                    return
                yield ev
        finally:
            holder["stop"] = True
            if cancel_wait:
                cancel_wait.cancel()
            resp = holder.get("resp")
            if resp is not None:
                try:
                    resp.close()
                except Exception:
                    pass

    async def complete(self, profile: dict, api_key: str | None, messages: list,
                       cancel: asyncio.Event | None = None) -> str:
        text = []
        async for ev in self.stream_chat(profile, api_key, messages, None, cancel):
            if ev["type"] == "text":
                text.append(ev["delta"])
            elif ev["type"] == "error":
                raise ProviderError(ev["message"])
        return "".join(text)


def get_provider(kind: str) -> OpenAICompatible:
    if kind == "anthropic":
        from .anthropic import AnthropicProvider
        return AnthropicProvider()
    if kind == "gemini_native":
        from .gemini import GeminiProvider
        return GeminiProvider()
    if kind not in PRESETS:
        raise ProviderError(f"未知的服务商类型：{kind}")
    return OpenAICompatible()
