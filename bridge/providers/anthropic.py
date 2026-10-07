"""Anthropic 原生 Messages API 适配器（流式 + 工具调用）。

内部统一使用 OpenAI 格式的消息；这里负责转换成 Anthropic 的格式：
system 单独提取；assistant 的工具调用变成 tool_use 块；tool 结果变成 user 消息里的 tool_result 块。
"""
from __future__ import annotations

import json
import urllib.request

from .sse_base import SseProvider
from .media import converted_content, ensure_vision, normalize_usage

API_VERSION = "2023-06-01"


def convert_messages(messages: list) -> tuple[str, list]:
    system_parts, out = [], []
    pending: list[dict] = []          # 连续的 tool 结果要合并进同一条 user 消息

    def flush():
        if pending:
            out.append({"role": "user", "content": list(pending)})
            pending.clear()

    for m in messages:
        role = m.get("role")
        if role == "system":
            system_parts.append(str(m.get("content") or ""))
        elif role == "tool":
            pending.append({"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": str(m.get("content") or "")})
        elif role == "user":
            flush()
            out.append({"role": "user", "content": converted_content(m.get("content"))})
        elif role == "assistant":
            flush()
            blocks = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                try:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                except ValueError:
                    args = {}
                blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["function"]["name"], "input": args})
            if blocks:
                out.append({"role": "assistant", "content": blocks})
    flush()
    return "\n\n".join(p for p in system_parts if p), out


class AnthropicProvider(SseProvider):
    def list_models(self, profile, api_key):
        url = profile["endpoint"].rstrip("/") + "/models"
        headers = {"Accept": "application/json", "anthropic-version": API_VERSION}
        if api_key:
            headers["x-api-key"] = api_key
        headers.update(profile.get("headers") or {})
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            from .openai_compat import ProviderError
            raise ProviderError(f"{type(e).__name__}: {e}") from e
        return sorted(dict.fromkeys(str(x.get("id")) for x in (payload.get("data") or []) if isinstance(x, dict) and x.get("id")), key=str.lower)

    def _request(self, profile, api_key, messages, tools):
        ensure_vision(profile, messages)
        system, msgs = convert_messages(messages)
        sampling = profile.get("sampling") or {}
        body = {"model": profile["model"], "max_tokens": int(sampling.get("max_tokens") or 8192), "stream": True, "messages": msgs}
        if system:
            body["system"] = system
        for k in ("temperature", "top_p"):
            if sampling.get(k) is not None:
                body[k] = sampling[k]
        mode = profile.get("_reasoning_mode", "auto")
        model = str(profile.get("model") or "").lower()
        # Claude's thinking API is generation-dependent. 4.6+ / Claude 5 use adaptive thinking;
        # 4.5 and older use manual extended thinking. Fable/Mythos keep adaptive thinking on,
        # so the UI's “off” choice deliberately degrades to low effort instead of sending an invalid request.
        always_adaptive = any(tag in model for tag in ("fable-5", "mythos-5", "mythos-preview"))
        adaptive = always_adaptive or any(tag in model for tag in (
            "opus-5", "sonnet-5", "4-6", "4.6", "4-7", "4.7", "4-8", "4.8"
        ))
        if mode == "on":
            if adaptive:
                body["thinking"] = {"type": "adaptive"}
                body["output_config"] = {"effort": "high"}
            else:
                body["thinking"] = {"type": "enabled", "budget_tokens": 4096}
        elif mode == "off":
            if always_adaptive:
                body["thinking"] = {"type": "adaptive"}
                body["output_config"] = {"effort": "low"}
            elif adaptive:
                body["thinking"] = {"type": "disabled"}
                body["output_config"] = {"effort": "medium"}
            # Older models already default to thinking off; omitting `thinking` is the compatible form.
        body.update(profile.get("extra_body") or {})
        if tools and profile.get("tool_calling", True):
            body["tools"] = [{"name": t["function"]["name"], "description": t["function"].get("description", ""),
                              "input_schema": t["function"]["parameters"]} for t in tools]
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream", "anthropic-version": API_VERSION}
        if api_key:
            headers["x-api-key"] = api_key
        headers.update(profile.get("headers") or {})
        url = profile["endpoint"].rstrip("/") + "/messages"
        return urllib.request.Request(url, json.dumps(body).encode("utf-8"), headers, method="POST")

    def handle(self, chunk, emit, state):
        raw = chunk.get("usage") or (chunk.get("message") or {}).get("usage")
        if isinstance(raw, dict):
            state.setdefault("usage", {}).update(raw)
            emit({"type": "usage", "usage": normalize_usage("anthropic", state["usage"])})
        t = chunk.get("type")
        idx = chunk.get("index", 0)
        calls = state["calls"]
        if t == "content_block_start":
            cb = chunk.get("content_block") or {}
            if cb.get("type") == "tool_use":
                calls[idx] = {"id": cb.get("id"), "name": cb.get("name", ""), "args": ""}
                emit({"type": "tool_call_delta", "index": idx, "id": cb.get("id"), "name": cb.get("name", ""), "args_chunk": ""})
        elif t == "content_block_delta":
            d = chunk.get("delta") or {}
            dt = d.get("type")
            if dt == "text_delta" and d.get("text"):
                emit({"type": "text", "delta": d["text"]})
            elif dt == "thinking_delta" and d.get("thinking"):
                emit({"type": "reasoning", "delta": d["thinking"]})
            elif dt == "input_json_delta" and idx in calls:
                calls[idx]["args"] += d.get("partial_json", "")
                emit({"type": "tool_call_delta", "index": idx, "id": calls[idx]["id"], "name": calls[idx]["name"],
                      "args_chunk": d.get("partial_json", "")})
        elif t == "message_delta":
            stop = (chunk.get("delta") or {}).get("stop_reason")
            if stop:
                self.complete_calls(state, emit, stop)
        elif t == "message_stop":
            if not state["finished"]:
                self.complete_calls(state, emit, "end_turn")
        elif t == "error":
            emit({"type": "error", "message": str(chunk.get("error"))[:500], "truncated": False})
            return "abort"
