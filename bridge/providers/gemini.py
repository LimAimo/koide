"""Google Gemini 原生 API 适配器（streamGenerateContent + functionCall）。"""
from __future__ import annotations

import json
import urllib.request

from .sse_base import SseProvider


def clean_schema(schema):
    """Gemini 的函数声明不接受 additionalProperties 等字段。"""
    if isinstance(schema, dict):
        return {k: clean_schema(v) for k, v in schema.items() if k not in ("additionalProperties", "$schema")}
    if isinstance(schema, list):
        return [clean_schema(x) for x in schema]
    return schema


def convert_messages(messages: list) -> tuple[str, list]:
    system_parts, contents = [], []
    names: dict[str, str] = {}         # tool_call_id -> 函数名，用于生成 functionResponse
    pending: list[dict] = []

    def flush():
        if pending:
            contents.append({"role": "user", "parts": list(pending)})
            pending.clear()

    for m in messages:
        role = m.get("role")
        if role == "system":
            system_parts.append(str(m.get("content") or ""))
        elif role == "user":
            flush()
            contents.append({"role": "user", "parts": [{"text": str(m.get("content") or "")}]})
        elif role == "assistant":
            flush()
            parts = []
            if m.get("content"):
                parts.append({"text": m["content"]})
            for tc in m.get("tool_calls") or []:
                names[tc["id"]] = tc["function"]["name"]
                try:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                except ValueError:
                    args = {}
                parts.append({"functionCall": {"name": tc["function"]["name"], "args": args}})
            if parts:
                contents.append({"role": "model", "parts": parts})
        elif role == "tool":
            pending.append({"functionResponse": {"name": names.get(m["tool_call_id"], "tool"),
                                                 "response": {"result": str(m.get("content") or "")}}})
    flush()
    return "\n\n".join(p for p in system_parts if p), contents


class GeminiProvider(SseProvider):
    def list_models(self, profile, api_key):
        url = profile["endpoint"].rstrip("/") + "/models"
        headers = {"Accept": "application/json"}
        if api_key:
            headers["x-goog-api-key"] = api_key
        headers.update(profile.get("headers") or {})
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            from .openai_compat import ProviderError
            raise ProviderError(f"{type(e).__name__}: {e}") from e
        ids = []
        for m in payload.get("models") or []:
            if not isinstance(m, dict) or not m.get("name"):
                continue
            methods = m.get("supportedGenerationMethods") or []
            if methods and "generateContent" not in methods:
                continue
            ids.append(str(m["name"]).removeprefix("models/"))
        return sorted(dict.fromkeys(ids), key=str.lower)

    def _request(self, profile, api_key, messages, tools):
        system, contents = convert_messages(messages)
        body: dict = {"contents": contents}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        s = profile.get("sampling") or {}
        gen = {k: s[v] for k, v in (("temperature", "temperature"), ("topP", "top_p"), ("maxOutputTokens", "max_tokens")) if s.get(v) is not None}
        mode = profile.get("_reasoning_mode", "auto")
        model_name = str(profile.get("model") or "").lower()
        if mode in ("on", "off"):
            if model_name.startswith("gemini-3"):
                # Gemini 3+ cannot always turn thinking fully off; LOW is supported broadly and is the safe minimum.
                gen["thinkingConfig"] = {"thinkingLevel": "HIGH" if mode == "on" else "LOW", "includeThoughts": mode == "on"}
            elif model_name.startswith("gemini-2.5"):
                if mode == "on":
                    gen["thinkingConfig"] = {"thinkingBudget": -1, "includeThoughts": True}
                elif "pro" in model_name:
                    gen["thinkingConfig"] = {"thinkingBudget": 128, "includeThoughts": False}
                else:
                    gen["thinkingConfig"] = {"thinkingBudget": 0, "includeThoughts": False}
        if gen:
            body["generationConfig"] = gen
        body.update(profile.get("extra_body") or {})
        if tools and profile.get("tool_calling", True):
            body["tools"] = [{"functionDeclarations": [
                {"name": t["function"]["name"], "description": t["function"].get("description", ""),
                 "parameters": clean_schema(t["function"]["parameters"])} for t in tools]}]
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if api_key:
            headers["x-goog-api-key"] = api_key
        headers.update(profile.get("headers") or {})
        model = profile["model"].removeprefix("models/")
        url = profile["endpoint"].rstrip("/") + f"/models/{model}:streamGenerateContent?alt=sse"
        return urllib.request.Request(url, json.dumps(body).encode("utf-8"), headers, method="POST")

    def handle(self, chunk, emit, state):
        if chunk.get("error"):
            emit({"type": "error", "message": str(chunk["error"])[:500], "truncated": False})
            return "abort"
        for cand in chunk.get("candidates") or []:
            for part in (cand.get("content") or {}).get("parts") or []:
                if part.get("thought") and part.get("text"):
                    emit({"type": "reasoning", "delta": part["text"]})
                elif part.get("text"):
                    emit({"type": "text", "delta": part["text"]})
                elif "functionCall" in part:
                    fc = part["functionCall"]
                    idx = len(state["calls"])
                    state["calls"][idx] = {"id": None, "name": fc.get("name", ""), "args": json.dumps(fc.get("args") or {})}
                    emit({"type": "tool_call_delta", "index": idx, "id": None, "name": fc.get("name", ""), "args_chunk": ""})
            if cand.get("finishReason"):
                self.complete_calls(state, emit, cand["finishReason"])
