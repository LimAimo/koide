"""End-to-end: WebSocket client -> Bridge -> agent loop -> mock OpenAI-compatible SSE server."""
import asyncio
import base64
import json
import os
import struct
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from bridge.app import BridgeApp
from bridge.server import serve

TRICKY = "<<<END>>>\n```\n</tool_call>\nEND_TOOL\n"
SRC = "def add(a, b):\n    return a - b\n"


# ---------------------------------------------------------------------------------------------
# Mock LLM
# ---------------------------------------------------------------------------------------------
class Mock:
    mode = "normal"
    requests: list = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def _sse(self, obj):
        self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
        self.wfile.flush()

    def _tool(self, idx, cid, name, args: dict, piece=7):
        s = json.dumps(args)
        self._sse({"choices": [{"delta": {"tool_calls": [{"index": idx, "id": cid, "function": {"name": name, "arguments": ""}}]}}]})
        for i in range(0, len(s), piece):
            self._sse({"choices": [{"delta": {"tool_calls": [{"index": idx, "function": {"arguments": s[i:i + piece]}}]}}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Mock.requests.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        msgs = body["messages"]
        if body.get("tools") is None and "approval reviewer" in msgs[0]["content"]:
            self._sse({"choices": [{"delta": {"content": '{"decision":"ALLOW","reason":"looks fine"}'}}]})
            self._sse({"choices": [{"delta": {}, "finish_reason": "stop"}]})
            return
        turn = sum(1 for m in msgs if m["role"] == "tool")
        if Mock.mode == "truncate":
            self._tool(0, "call_x", "fs_write", {"path": "should_not_exist.txt", "content": "x"})
            return   # stream dies without finish_reason
        if Mock.mode == "escape":
            if turn == 0:
                self._tool(0, "c1", "fs_read", {"path": "../outside.txt"})
                self._sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
            else:
                self._sse({"choices": [{"delta": {"content": "blocked"}}]})
                self._sse({"choices": [{"delta": {}, "finish_reason": "stop"}]})
            return
        if turn == 0:
            self._sse({"choices": [{"delta": {"content": "Looking at the code. "}}]})
            self._tool(0, "c1", "fs_read", {"path": "src/app.py"})
            self._sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
        elif turn == 1:
            self._tool(0, "c2", "fs_patch", {"path": "src/app.py", "edits": [
                {"old_text": "return a - b", "new_text": "return a + b  # fixed " + TRICKY}]})
            self._sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
        elif turn == 2:
            self._tool(0, "c3", "shell_run", {"command": f"{sys.executable} -c \"print('build ok')\""})
            self._sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
        else:
            self._sse({"choices": [{"delta": {"content": "Fixed the bug in add()."}}]})
            self._sse({"choices": [{"delta": {}, "finish_reason": "stop"}]})
        self.wfile.write(b"data: [DONE]\n\n")


# ---------------------------------------------------------------------------------------------
# Tiny WebSocket client
# ---------------------------------------------------------------------------------------------
class Client:
    def __init__(self):
        self.events, self._futs, self._id = [], {}, 0

    async def connect(self, port, origin=None, host=None):
        self.r, self.w = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f"GET /ws HTTP/1.1", f"Host: {host or f'127.0.0.1:{port}'}", "Upgrade: websocket",
                 "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        if origin:
            lines.append(f"Origin: {origin}")
        self.w.write(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = await self.r.readuntil(b"\r\n\r\n")
        status = int(head.split(b" ")[1])
        if status == 101:
            self.task = asyncio.create_task(self._reader())
        return status

    async def _reader(self):
        try:
            while True:
                h = await self.r.readexactly(2)
                n = h[1] & 0x7F
                if n == 126:
                    n = struct.unpack("!H", await self.r.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", await self.r.readexactly(8))[0]
                data = await self.r.readexactly(n)
                if h[0] & 0x0F != 1:
                    continue
                msg = json.loads(data)
                if msg["type"] == "event":
                    self.events.append(msg)
                elif msg["id"] in self._futs:
                    self._futs.pop(msg["id"]).set_result(msg)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass

    async def rpc(self, method, params=None, expect_error=False):
        self._id += 1
        fut = asyncio.get_running_loop().create_future()
        self._futs[self._id] = fut
        payload = json.dumps({"type": "rpc", "id": self._id, "method": method, "params": params or {}}).encode()
        mask = os.urandom(4)
        n = len(payload)
        head = bytearray([0x81])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        self.w.write(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        msg = await asyncio.wait_for(fut, 10)
        if expect_error:
            assert msg["type"] == "error", msg
            return msg["error"]
        assert msg["type"] == "result", msg
        return msg["result"]

    async def wait_event(self, name, pred=lambda d: True, timeout=15):
        end = asyncio.get_running_loop().time() + timeout
        seen = 0
        while asyncio.get_running_loop().time() < end:
            while seen < len(self.events):
                e = self.events[seen]
                seen += 1
                if e["event"] == name and pred(e["data"]):
                    return e["data"]
            await asyncio.sleep(0.02)
        raise AssertionError(f"timeout waiting for {name}; got {[e['event'] for e in self.events][-12:]}")

    def named(self, name):
        return [e["data"] for e in self.events if e["event"] == name]


class E2EBase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.td = tempfile.TemporaryDirectory()
        tmp = Path(self.td.name)
        self.proj = tmp / "proj"
        (self.proj / "src").mkdir(parents=True)
        (self.proj / "src" / "app.py").write_text(SRC)
        (tmp / "outside.txt").write_text("secret")
        self.app = BridgeApp(tmp / "data", ROOT / "apps" / "web", ROOT / "bridge")
        self.server = await serve(self.app, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.llm = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.llm.serve_forever, daemon=True).start()
        Mock.mode, Mock.requests = "normal", []
        self.c = Client()
        self.assertEqual(await self.c.connect(self.port), 101)
        await self.c.rpc("hello")
        await self.c.rpc("workspace.open", {"path": str(self.proj)})
        await self.c.rpc("profiles.save", {"profile": {
            "id": "mock", "kind": "openai_compatible", "model": "mock",
            "endpoint": f"http://127.0.0.1:{self.llm.server_address[1]}/v1"}, "api_key": "sk-test-123"})

    async def asyncTearDown(self):
        if self.app.agent:
            self.app.agent.stop()
            await asyncio.sleep(0.3)
        self.c.w.close()
        self.llm.shutdown()
        self.server.close()
        self.td.cleanup()

    async def run_agent(self, mode="autonomous", goal="fix add()"):
        await self.c.rpc("permissions.set", {"mode": mode})
        await self.c.rpc("agent.start", {"goal": goal, "profile": "mock", "mode": "agent"})



class E2E(E2EBase):
    async def test_full_agent_run_autonomous(self):
        await self.run_agent("autonomous")
        done = await self.c.wait_event("agent.done")
        self.assertEqual(done["status"], "done", done)

        # code containing terminator-like text arrived intact
        patched = (self.proj / "src" / "app.py").read_text()
        self.assertIn("return a + b  # fixed " + TRICKY, patched)

        # the diffusion event carries true before/after text
        ch = [c for c in self.c.named("fs.changed") if c["actor"] == "agent"][-1]
        self.assertEqual(ch["before_text"], SRC)
        self.assertIn("a + b", ch["after_text"])

        # Tool cards appear as soon as the provider announces a native tool call, before execution begins.
        states = [(t["call_id"], t["state"]) for t in self.c.named("agent.tool")]
        for cid in ("c1", "c2", "c3"):
            self.assertIn((cid, "preparing"), states)
            self.assertIn((cid, "done"), states)
            per_call = [state for call_id, state in states if call_id == cid]
            self.assertLess(per_call.index("preparing"), per_call.index("done"))
        self.assertTrue(any(s.get("state") == "thinking" for s in self.c.named("agent.status")))
        msg = "".join(m["delta"] for m in self.c.named("agent.message"))
        self.assertIn("Fixed the bug", msg)
        self.assertTrue(any("build ok" in o["data"] for o in self.c.named("terminal.output")))

        # the API key never reaches the client, but did reach the provider
        blob = json.dumps(self.c.events)
        self.assertNotIn("sk-test-123", blob)
        prof = (await self.c.rpc("profiles.list"))["profiles"][0]
        self.assertTrue(prof["has_key"])
        self.assertNotIn("api_key", prof)

        # AGENTS.md-less system prompt still names the workspace
        self.assertIn(str(self.proj), Mock.requests[0]["messages"][0]["content"])

        # Time Machine: timeline + revert whole task
        tasks = (await self.c.rpc("checkpoint.tasks"))["tasks"]
        self.assertEqual(tasks[0]["status"], "done")
        task = await self.c.rpc("checkpoint.task", {"task_id": tasks[0]["id"]})
        types = [e["type"] for e in task["events"]]
        self.assertEqual(types[0], "task_started")
        self.assertIn("edit", types)
        self.assertIn("build_ok", types)
        self.assertEqual(types[-1], "task_complete")
        edit = next(e for e in task["events"] if e["type"] == "edit")
        diff = await self.c.rpc("checkpoint.diff", {"task_id": task["id"], "seq": edit["seq"]})
        self.assertEqual(diff["before"], SRC)
        await self.c.rpc("checkpoint.revert_task", {"task_id": task["id"]})
        self.assertEqual((self.proj / "src" / "app.py").read_text(), SRC)

    async def test_manual_mode_asks_then_allows(self):
        await self.run_agent("manual")
        req = await self.c.wait_event("approval.request", lambda d: d["tool"] == "fs_patch")
        self.assertEqual((self.proj / "src" / "app.py").read_text(), SRC)   # nothing happened yet
        await self.c.rpc("approval.respond", {"approval_id": req["approval_id"], "allow": True, "scope": "once"})
        req2 = await self.c.wait_event("approval.request", lambda d: d["tool"] == "shell_run")
        await self.c.rpc("approval.respond", {"approval_id": req2["approval_id"], "allow": True, "scope": "session"})
        done = await self.c.wait_event("agent.done")
        self.assertEqual(done["status"], "done")
        self.assertIn("a + b", (self.proj / "src" / "app.py").read_text())

    async def test_manual_mode_decline_keeps_file(self):
        await self.run_agent("manual")
        req = await self.c.wait_event("approval.request", lambda d: d["tool"] == "fs_patch")
        await self.c.rpc("approval.respond", {"approval_id": req["approval_id"], "allow": False})
        req2 = await self.c.wait_event("approval.request", lambda d: d["tool"] == "shell_run")   # agent carries on
        await self.c.rpc("approval.respond", {"approval_id": req2["approval_id"], "allow": False})
        await self.c.wait_event("agent.done")
        self.assertEqual((self.proj / "src" / "app.py").read_text(), SRC)
        declined = [t for t in self.c.named("agent.tool") if t["state"] == "denied"]
        self.assertEqual(len(declined), 2)

    async def test_stop_while_waiting_for_approval(self):
        await self.run_agent("manual")
        await self.c.wait_event("approval.request")
        await self.c.rpc("agent.stop")
        done = await self.c.wait_event("agent.done")
        self.assertEqual(done["status"], "stopped")
        self.assertEqual((self.proj / "src" / "app.py").read_text(), SRC)

    async def test_ai_approval_mode_uses_reviewer_model(self):
        await self.run_agent("ai")
        done = await self.c.wait_event("agent.done", timeout=20)
        self.assertEqual(done["status"], "done", done)
        self.assertFalse(self.c.named("approval.request"))
        self.assertTrue(any(r["messages"][0]["content"].startswith("You are the approval reviewer") for r in Mock.requests))

    async def test_truncated_stream_never_executes_tool(self):
        Mock.mode = "truncate"
        await self.run_agent("autonomous")
        done = await self.c.wait_event("agent.done")
        self.assertEqual(done["status"], "error")
        self.assertFalse((self.proj / "should_not_exist.txt").exists())

    async def test_agent_cannot_escape_workspace(self):
        Mock.mode = "escape"
        await self.run_agent("autonomous")
        await self.c.wait_event("agent.done")
        card = [t for t in self.c.named("agent.tool") if t["state"] == "error"][0]
        self.assertIn("OUTSIDE_WORKSPACE", card["detail"])

    async def test_hard_policy_beats_autonomous(self):
        from bridge.tools.registry import Tool
        tool = self.app.tools.get("shell_run")
        self.app.permissions.set_mode("autonomous")
        ws = self.app.workspace
        d = await self.app.permissions.evaluate(tool, {"command": "rm -rf /"}, ws)
        self.assertEqual((d.action, d.source), ("deny", "hard_policy"))
        d = await self.app.permissions.evaluate(tool, {"command": "git push --force"}, ws)
        self.assertEqual((d.action, d.source), ("ask", "hard_policy"))
        self.app.permissions.set_tool("shell_run", "always")
        d = await self.app.permissions.evaluate(tool, {"command": "git push --force"}, ws)
        self.assertEqual(d.action, "ask")               # "Always Allow" cannot override Hard Policy
        d = await self.app.permissions.evaluate(tool, {"command": "npm test"}, ws)
        self.assertEqual(d.action, "allow")

        async def rogue_reviewer(_):
            return "ALLOW", "sure"
        self.app.permissions.set_mode("ai")
        self.app.permissions.set_tool("shell_run", None)
        d = await self.app.permissions.evaluate(tool, {"command": "rm -rf /"}, ws, rogue_reviewer)
        self.assertEqual(d.action, "deny")             # Approval Agent cannot override Hard Policy

    async def test_user_edit_conflict_and_transactional_write_over_ws(self):
        rd = await self.c.rpc("fs.read", {"path": "src/app.py"})
        (self.proj / "src" / "app.py").write_text("changed by someone else\n")
        err = await self.c.rpc("fs.write", {"path": "src/app.py", "content": "mine", "base_revision": rd["revision"]},
                               expect_error=True)
        self.assertEqual(err["code"], "CONFLICT")
        w = (await self.c.rpc("fs.begin_write", {"path": "big.txt"}))["write_id"]
        import hashlib
        await self.c.rpc("fs.write_chunk", {"write_id": w, "seq": 0, "data": "hello"})
        await self.c.rpc("fs.commit_write", {"write_id": w, "total_bytes": 5,
                                             "sha256": hashlib.sha256(b"hello").hexdigest()})
        self.assertEqual((self.proj / "big.txt").read_text(), "hello")


class Security(unittest.IsolatedAsyncioTestCase):
    async def test_origin_and_host_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = BridgeApp(Path(td), ROOT / "apps" / "web", ROOT / "bridge")
            server = await serve(app, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                self.assertEqual(await Client().connect(port, origin="https://evil.example"), 403)
                self.assertEqual(await Client().connect(port, host="evil.example"), 403)
                self.assertEqual(await Client().connect(port, origin=f"http://127.0.0.1:{port}"), 101)
            finally:
                server.close()

    async def test_lan_pairing(self):
        import urllib.request
        with tempfile.TemporaryDirectory() as td:
            app = BridgeApp(Path(td), ROOT / "apps" / "web", ROOT / "bridge", lan=True)
            self.assertIsNone(app.devices.verify("nope"))
            code = app.devices.new_code()
            self.assertIsNone(app.devices.pair("000000" if code != "000000" else "111111", "x"))
            token = app.devices.pair(code, "phone")
            self.assertIsNotNone(token)
            self.assertIsNone(app.devices.pair(code, "again"))          # single use
            self.assertEqual(app.devices.verify(token)["name"], "phone")
            dev = app.devices.list()[0]
            self.assertNotIn("hash", dev)
            app.devices.revoke(dev["id"])
            self.assertIsNone(app.devices.verify(token))


if __name__ == "__main__":
    unittest.main()
