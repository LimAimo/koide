"""SSE 流式适配器的公共基类：负责读取数据行、处理 HTTP 错误、检测流被截断。

子类只需要实现 `handle(chunk, emit, state)`：把厂商的数据块翻译成统一事件。
只有当厂商明确报告结束（`complete_calls`）时，工具调用才会被标记为完成；
流在没有结束标志时中断，未完成的工具调用会被丢弃。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid

from .openai_compat import OpenAICompatible


class SseProvider(OpenAICompatible):
    def handle(self, chunk: dict, emit, state: dict):  # pragma: no cover - 由子类实现
        raise NotImplementedError

    @staticmethod
    def complete_calls(state: dict, emit, reason: str) -> None:
        state["finished"] = True
        for idx in sorted(state["calls"]):
            c = state["calls"][idx]
            cid = c.get("id") or f"call_{uuid.uuid4().hex[:10]}"
            try:
                args = json.loads(c["args"]) if c["args"].strip() else {}
                err = None if isinstance(args, dict) else "arguments must be a JSON object"
            except ValueError as e:
                args, err = None, f"工具参数不是有效的 JSON：{e}"
            emit({"type": "tool_call_complete", "index": idx, "id": cid, "name": c["name"],
                  "arguments": args if not err else None, "error": err})
        state["calls"].clear()
        emit({"type": "finish", "reason": reason})

    def _worker(self, req, emit, holder):
        state = {"calls": {}, "finished": False}
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
                if payload in ("", "[DONE]"):
                    continue
                try:
                    chunk = json.loads(payload)
                except ValueError:
                    continue
                if self.handle(chunk, emit, state) == "abort":
                    return
            if not state["finished"] and not holder["stop"]:
                emit({"type": "error", "truncated": True,
                      "message": "模型的输出在完成之前就中断了，未完成的工具调用已被丢弃"})
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except Exception:
                detail = ""
            emit({"type": "error", "message": f"HTTP {e.code}：{detail or e.reason}", "truncated": False})
        except Exception as e:
            if not holder["stop"]:
                emit({"type": "error", "message": f"{type(e).__name__}：{e}", "truncated": not state["finished"]})
