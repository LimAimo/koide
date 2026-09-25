"""Anthropic 与 Gemini 原生适配器：用假服务端验证请求格式转换、流式事件和「只在明确结束后才完成工具调用」。"""
import asyncio
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bridge.providers.openai_compat import get_provider

TRICKY = "<<<END>>>\n```\n</tool_call>"
TOOLS = [{"type": "function", "function": {"name": "fs_patch", "description": "改文件",
          "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}}}]
MESSAGES = [
    {"role": "system", "content": "你是助手"},
    {"role": "user", "content": "修一下"},
    {"role": "assistant", "content": "先读文件", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "fs_read", "arguments": '{"path":"a.py"}'}}]},
    {"role": "tool", "tool_call_id": "t1", "content": "print(1)"},
    {"role": "user", "content": "继续"},
]


class Rec:
    body = None
    headers = None
    path = None
    mode = "ok"


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if self.path.startswith("/v1beta/models"):
            payload = {"models": [
                {"name": "models/gemini-test-a", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/embed-only", "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/gemini-test-b", "supportedGenerationMethods": ["generateContent"]},
            ]}
        else:
            payload = {"data": [{"id": "claude-test-b"}, {"id": "claude-test-a"}]}
        self.wfile.write(json.dumps(payload).encode())

    def do_POST(self):
        Rec.path = self.path
        Rec.headers = {k.lower(): v for k, v in self.headers.items()}
        Rec.body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        w = lambda o, ev=None: self.wfile.write(((f"event: {ev}\n" if ev else "") + "data: " + json.dumps(o) + "\n\n").encode()) or self.wfile.flush()
        args = json.dumps({"path": "a.py", "note": TRICKY})
        if "/messages" in self.path:                       # Anthropic
            w({"type": "message_start", "message": {}}, "message_start")
            w({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            w({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "好的，"}})
            w({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "我来改。"}})
            w({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "fs_patch", "input": {}}})
            for i in range(0, len(args), 6):
                w({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": args[i:i + 6]}})
            if Rec.mode == "truncate":
                return
            w({"type": "message_delta", "delta": {"stop_reason": "tool_use"}})
            w({"type": "message_stop"})
        else:                                              # Gemini
            w({"candidates": [{"content": {"parts": [{"text": "好的，"}]}}]})
            w({"candidates": [{"content": {"parts": [{"functionCall": {"name": "fs_patch", "args": {"path": "a.py", "note": TRICKY}}}]}}]})
            if Rec.mode == "truncate":
                return
            w({"candidates": [{"content": {"parts": []}, "finishReason": "STOP"}]})


async def collect(kind, port, mode="ok"):
    Rec.mode = mode
    prov = get_provider(kind)
    profile = {"kind": kind, "model": "m-1", "endpoint": f"http://127.0.0.1:{port}/v1" if kind == "anthropic" else f"http://127.0.0.1:{port}/v1beta"}
    return [e async for e in prov.stream_chat(profile, "KEY123", MESSAGES, TOOLS)]


class Providers(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]

    async def asyncTearDown(self):
        self.srv.shutdown()

    def check_events(self, evs):
        self.assertEqual("".join(e["delta"] for e in evs if e["type"] == "text"), "好的，" if evs and not any("我来改" in str(e) for e in evs) else "好的，我来改。")
        done = [e for e in evs if e["type"] == "tool_call_complete"]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["name"], "fs_patch")
        self.assertEqual(done[0]["arguments"]["note"], TRICKY)          # 含终止符样式的文本不会提前截断
        self.assertIsNone(done[0]["error"])
        self.assertEqual(evs[-1]["type"], "finish")

    async def test_anthropic_request_and_stream(self):
        evs = await collect("anthropic", self.port)
        self.check_events(evs)
        self.assertEqual(Rec.path, "/v1/messages")
        self.assertEqual(Rec.headers["x-api-key"], "KEY123")
        self.assertEqual(Rec.headers["anthropic-version"], "2023-06-01")
        b = Rec.body
        self.assertEqual(b["system"], "你是助手")
        self.assertEqual([m["role"] for m in b["messages"]], ["user", "assistant", "user", "user"])
        self.assertEqual(b["messages"][1]["content"][1], {"type": "tool_use", "id": "t1", "name": "fs_read", "input": {"path": "a.py"}})
        self.assertEqual(b["messages"][2]["content"][0]["type"], "tool_result")
        self.assertEqual(b["tools"][0]["input_schema"]["required"], ["path"])
        self.assertTrue(b["stream"])

    async def test_gemini_request_and_stream(self):
        evs = await collect("gemini_native", self.port)
        self.check_events(evs)
        self.assertIn(":streamGenerateContent?alt=sse", Rec.path)
        self.assertEqual(Rec.headers["x-goog-api-key"], "KEY123")
        b = Rec.body
        self.assertEqual(b["systemInstruction"]["parts"][0]["text"], "你是助手")
        self.assertEqual([c["role"] for c in b["contents"]], ["user", "model", "user", "user"])
        self.assertEqual(b["contents"][2]["parts"][0]["functionResponse"]["name"], "fs_read")
        decl = b["tools"][0]["functionDeclarations"][0]
        self.assertNotIn("additionalProperties", decl["parameters"])

    async def test_native_model_discovery_returns_selectable_generation_models(self):
        anthropic = get_provider("anthropic")
        a = await asyncio.to_thread(anthropic.list_models, {"endpoint": f"http://127.0.0.1:{self.port}/v1"}, "KEY123")
        self.assertEqual(a, ["claude-test-a", "claude-test-b"])
        gemini = get_provider("gemini_native")
        g = await asyncio.to_thread(gemini.list_models, {"endpoint": f"http://127.0.0.1:{self.port}/v1beta"}, "KEY123")
        self.assertEqual(g, ["gemini-test-a", "gemini-test-b"])

    def test_anthropic_reasoning_modes_degrade_by_model_capability(self):
        prov = get_provider("anthropic")
        base = {"kind": "anthropic", "endpoint": "https://example.invalid/v1", "model": "claude-opus-4-8"}
        body = json.loads(prov._request({**base, "_reasoning_mode": "on"}, "K", MESSAGES, None).data)
        self.assertEqual(body["thinking"], {"type": "adaptive"})
        self.assertEqual(body["output_config"]["effort"], "high")
        body = json.loads(prov._request({**base, "_reasoning_mode": "off"}, "K", MESSAGES, None).data)
        self.assertEqual(body["thinking"], {"type": "disabled"})

        old = {**base, "model": "claude-sonnet-4-5", "_reasoning_mode": "on"}
        body = json.loads(prov._request(old, "K", MESSAGES, None).data)
        self.assertEqual(body["thinking"]["type"], "enabled")
        self.assertGreaterEqual(body["thinking"]["budget_tokens"], 1024)
        old["_reasoning_mode"] = "off"
        body = json.loads(prov._request(old, "K", MESSAGES, None).data)
        self.assertNotIn("thinking", body)

        always = {**base, "model": "claude-fable-5", "_reasoning_mode": "off"}
        body = json.loads(prov._request(always, "K", MESSAGES, None).data)
        self.assertEqual(body["thinking"], {"type": "adaptive"})
        self.assertEqual(body["output_config"]["effort"], "low")

    async def test_truncated_streams_discard_tool_calls(self):
        for kind in ("anthropic", "gemini_native"):
            evs = await collect(kind, self.port, "truncate")
            self.assertFalse([e for e in evs if e["type"] == "tool_call_complete"], kind)
            self.assertEqual(evs[-1]["type"], "error")
            self.assertTrue(evs[-1]["truncated"])


if __name__ == "__main__":
    unittest.main()
