"""PTY 终端、导出、会话上下文、权限规则、全局指令、Git RPC，全部走真实 WebSocket。"""
import asyncio
import io
import json
import shutil
import subprocess
import sys
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bridge.security.permissions import PermissionEngine
from bridge.terminal.pty_session import HAVE_PTY
from tests.bridge.test_e2e import E2EBase, Mock


def http_get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Extras(E2EBase):
    @unittest.skipUnless(HAVE_PTY, "需要 PTY")
    async def test_pty_terminal(self):
        r = await self.c.rpc("terminal.open", {"cols": 100, "rows": 30})
        sid = r["id"]
        await self.c.rpc("terminal.input", {"id": sid, "data": "echo dfx_$((40+2)); pwd\n"})
        await self.c.wait_event("terminal.data", lambda d: d["id"] == sid and "dfx_42" in d["data"])
        hist = await self.c.rpc("terminal.history", {"id": sid})
        self.assertIn(self.proj.name, hist["data"])                        # 终端在项目文件夹里启动
        await self.c.rpc("terminal.resize", {"id": sid, "cols": 60, "rows": 20})
        await self.c.rpc("terminal.input", {"id": sid, "data": "exit\n"})
        closed = await self.c.wait_event("terminal.closed", lambda d: d["id"] == sid)
        self.assertEqual(closed["exit_code"], 0)
        self.assertFalse((await self.c.rpc("terminal.list"))["sessions"][0]["alive"])

    @unittest.skipUnless(HAVE_PTY, "需要 PTY")
    async def test_agent_can_read_terminal_output_but_it_asks_first(self):
        sid = (await self.c.rpc("terminal.open", {}))["id"]
        await self.c.rpc("terminal.input", {"id": sid, "data": "echo visible_marker\n"})
        await self.c.wait_event("terminal.data", lambda d: "visible_marker" in d["data"])
        tool = self.app.tools.get("terminal_read")
        self.app.permissions.set_mode("manual")
        d = await self.app.permissions.evaluate(tool, {}, self.app.workspace)
        self.assertEqual(d.action, "ask")                                  # 读终端属于执行类，手动模式要确认
        out = await tool.handler(type("TC", (), {"terminals": self.app.terminals})(), {})
        self.assertIn("visible_marker", out["output"])
        await self.c.rpc("terminal.close", {"id": sid})

    async def test_ports_list(self):
        r = await self.c.rpc("ports.list")
        self.assertIsInstance(r["ports"], list)
        if sys.platform.startswith("linux"):
            self.assertIn(self.port, [p["port"] for p in r["ports"]])      # Bridge 自己就在监听

    async def test_export_zip_is_single_use_and_skips_junk(self):
        (self.proj / "node_modules").mkdir()
        (self.proj / "node_modules" / "x.js").write_text("junk")
        (self.proj / "src" / "b.txt").write_text("你好")
        r = await self.c.rpc("fs.export", {"path": "."})
        self.assertTrue(r["name"].endswith(".zip"))
        status, body = await asyncio.to_thread(http_get, f"http://127.0.0.1:{self.port}{r['url']}")
        self.assertEqual(status, 200)
        names = zipfile.ZipFile(io.BytesIO(body)).namelist()
        self.assertTrue(any(n.endswith("src/app.py") for n in names))
        self.assertTrue(any(n.endswith("src/b.txt") for n in names))
        self.assertFalse(any("node_modules" in n for n in names))
        again, _ = await asyncio.to_thread(http_get, f"http://127.0.0.1:{self.port}{r['url']}")
        self.assertEqual(again, 404)                                        # 链接只能用一次
        err = await self.c.rpc("fs.export", {"path": "../outside.txt"}, expect_error=True)
        self.assertEqual(err["code"], "OUTSIDE_WORKSPACE")

    async def test_conversations_carry_context_between_tasks(self):
        await self.c.rpc("permissions.set", {"mode": "autonomous"})
        r1 = await self.c.rpc("agent.start", {"goal": "第一件事：修 add()", "profile": "mock", "mode": "agent"})
        cid = r1["conversation_id"]
        await self.c.wait_event("agent.done")
        conv = await self.c.rpc("conv.get", {"id": cid})
        roles = [e["role"] for e in conv["entries"]]
        self.assertEqual(roles[0], "user")
        self.assertIn("assistant", roles)
        self.assertIn("tool", roles)
        self.assertEqual(roles[-1], "note")
        self.c.events.clear()
        Mock.requests.clear()
        await self.c.rpc("agent.start", {"goal": "第二件事", "profile": "mock", "mode": "agent", "conversation_id": cid})
        await self.c.wait_event("agent.done")
        sent = [m["content"] for m in Mock.requests[0]["messages"] if m["role"] == "user"]
        self.assertEqual(sent[0], "第一件事：修 add()")                       # 第二个任务带着上一个任务的对话
        self.assertEqual(sent[-1], "第二件事")
        self.assertEqual(len((await self.c.rpc("conv.list"))["conversations"]), 1)
        await self.c.rpc("conv.delete", {"id": cid})
        self.assertEqual((await self.c.rpc("conv.list"))["conversations"], [])

    async def test_permission_rules_and_instructions(self):
        await self.c.rpc("permissions.set", {"mode": "manual", "tool_rules": {
            "shell_run": {"allow": ["npm test*", "pytest*"], "deny": ["*deploy*"]},
            "fs_patch": {"deny": ["secrets/*"]}}})
        cfg = self.app.permissions
        shell, patch = self.app.tools.get("shell_run"), self.app.tools.get("fs_patch")
        ws = self.app.workspace
        self.assertEqual((await cfg.evaluate(shell, {"command": "npm test -- --watch=false"}, ws)).action, "allow")
        self.assertEqual((await cfg.evaluate(shell, {"command": "npm run deploy"}, ws)).source, "rule")
        self.assertEqual((await cfg.evaluate(shell, {"command": "npm run deploy"}, ws)).action, "deny")
        self.assertEqual((await cfg.evaluate(shell, {"command": "ls"}, ws)).action, "ask")          # 没命中规则：按模式询问
        self.assertEqual((await cfg.evaluate(patch, {"path": "secrets/key.txt", "edits": []}, ws)).action, "deny")
        forced = await cfg.evaluate(shell, {"command": "pytest && git push --force"}, ws)
        self.assertEqual(forced.action, "ask")                                                      # 硬性规则优先于「自动允许」
        self.assertEqual(forced.source, "hard_policy")
        self.assertIn("shell_run", (await self.c.rpc("permissions.set", {}))["tool_rules"])
        await self.c.rpc("instructions.set", {"global": "永远用中文回答"})
        (self.proj / "AGENTS.md").write_text("# 项目规则\n")
        r = await self.c.rpc("instructions.get")
        self.assertEqual(r["global"], "永远用中文回答")
        self.assertTrue(r["project_exists"])
        Mock.requests.clear()
        await self.c.rpc("permissions.set", {"mode": "autonomous"})
        await self.c.rpc("agent.start", {"goal": "x", "profile": "mock", "mode": "agent"})
        await self.c.wait_event("agent.done")
        sys_prompt = Mock.requests[0]["messages"][0]["content"]
        self.assertIn("永远用中文回答", sys_prompt)
        self.assertIn("项目规则", sys_prompt)
        self.assertIn("第一原则：诚实优先", sys_prompt)
        self.assertIn("第十三原则：真正的\"温度\"来自理解，而不是模板", sys_prompt)

    async def test_constitution_ask_user_and_location_picker(self):
        text = (await self.c.rpc("instructions.constitution"))["text"]
        self.assertIn("第一原则：诚实优先", text)
        self.assertIn("第十三原则：真正的\"温度\"来自理解，而不是模板", text)
        self.assertGreater(len(text), 2200)
        tool = self.app.tools.get("ask_user")
        self.assertIsNotNone(tool)
        self.assertEqual((await self.app.permissions.evaluate(tool, {"questions": [{"question": "选哪个？"}]}, self.app.workspace)).action, "allow")
        fut = self.app.request_question({"questions": [{"question": "A 还是 B？", "options": ["A", "B"], "allow_custom": True}]})
        ev = await self.c.wait_event("agent.question")
        self.assertEqual(ev["questions"][0]["question"], "A 还是 B？")
        await self.c.rpc("agent.answer", {"question_id": ev["question_id"], "answers": ["B"]})
        self.assertEqual(await fut, ["B"])
        root = await self.c.rpc("workspace.browse", {"path": str(Path(self.proj).anchor)})
        self.assertEqual(root["parent"], "__locations__")
        locations = await self.c.rpc("workspace.browse", {"path": "__locations__"})
        self.assertTrue(locations["virtual"])
        self.assertTrue(locations["entries"])

    @unittest.skipUnless(shutil.which("git"), "需要 git")
    async def test_git_rpcs(self):
        err = (await self.c.rpc("git.status"))
        self.assertFalse(err["is_repo"])
        await self.c.rpc("git.init")
        subprocess.run(["git", "config", "user.name", "T"], cwd=self.proj, check=True)
        subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=self.proj, check=True)
        st = await self.c.rpc("git.status")
        self.assertTrue(any(f["path"] == "src/app.py" for f in st["files"]))
        await self.c.rpc("git.stage", {"paths": ["src/app.py"]})
        await self.c.wait_event("git.changed")
        first = (await self.c.rpc("git.commit", {"message": "初始提交"}))["hash"]
        self.assertEqual((await self.c.rpc("git.log"))["commits"][0]["subject"], "初始提交")
        (self.proj / "src" / "app.py").write_text("第二版\n")
        await self.c.rpc("git.stage", {"paths": ["src/app.py"]})
        await self.c.rpc("git.commit", {"message": "第二版"})
        await self.c.rpc("git.reset", {"hash": first, "mode": "soft"})
        self.assertEqual((self.proj / "src" / "app.py").read_text(), "第二版\n")
        e = await self.c.rpc("git.reset", {"hash": first, "mode": "hard"}, expect_error=True)
        self.assertEqual(e["code"], "NEEDS_CONFIRM")
        await self.c.rpc("git.reset", {"hash": first, "mode": "hard", "confirm": True})
        self.assertIn("return a - b", (self.proj / "src" / "app.py").read_text())
        (self.proj / "src" / "app.py").write_text("改坏了\n")
        e = await self.c.rpc("git.discard", {"path": "src/app.py"}, expect_error=True)
        self.assertEqual(e["code"], "NEEDS_CONFIRM")                        # 丢弃必须明确确认
        await self.c.rpc("git.discard", {"path": "src/app.py", "confirm": True})
        self.assertNotEqual((self.proj / "src" / "app.py").read_text(), "改坏了\n")
        (self.proj / "new.txt").write_text("x")
        await self.c.rpc("git.discard", {"path": "new.txt", "confirm": True})
        self.assertFalse((self.proj / "new.txt").exists())
        trash_items = (await self.c.rpc("trash.list"))["items"]
        originals = {Path(x["original"]).name for x in trash_items}
        self.assertIn("app.py", originals)  # 强制回退覆盖的已跟踪内容同样可恢复
        self.assertIn("new.txt", originals) # 未跟踪文件进回收站，而不是永久删除
        e = await self.c.rpc("git.diff", {"path": "../outside.txt"}, expect_error=True)
        self.assertEqual(e["code"], "OUTSIDE_WORKSPACE")


class LanPairing(unittest.IsolatedAsyncioTestCase):
    async def test_pair_code_addresses_token_and_revoke(self):
        import tempfile
        from bridge.app import BridgeApp
        from bridge.protocol.net import lan_addresses
        from bridge.server import serve
        from tests.bridge.test_e2e import Client
        for ip in lan_addresses():
            self.assertRegex(ip, r"^\d+\.\d+\.\d+\.\d+$")
            self.assertFalse(ip.startswith("127."))
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as td:
            app = BridgeApp(Path(td), root / "apps" / "web", root / "bridge", lan=True)
            server = await serve(app, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            c = Client()
            try:
                self.assertEqual(await c.connect(port), 101)
                await c.rpc("hello")
                r = await c.rpc("devices.pair_code")
                self.assertRegex(r["code"], r"^\d{6}$")
                self.assertEqual(r["port"], app.port)
                self.assertIsInstance(r["addresses"], list)

                def pair(code):
                    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/pair", json.dumps({"code": code, "name": "测试手机"}).encode(),
                                                 {"Content-Type": "application/json"}, method="POST")
                    try:
                        with urllib.request.urlopen(req, timeout=5) as resp:
                            return resp.status, json.loads(resp.read())
                    except urllib.error.HTTPError as e:
                        return e.code, json.loads(e.read())
                status, body = await asyncio.to_thread(pair, r["code"])
                self.assertEqual(status, 200)
                self.assertGreater(len(body["token"]), 20)
                status, body2 = await asyncio.to_thread(pair, r["code"])
                self.assertEqual(status, 401)                                            # 配对码只能用一次
                self.assertIn("配对码", body2["error"])
                devs = (await c.rpc("devices.list"))["devices"]
                self.assertEqual([d["name"] for d in devs], ["测试手机"])
                self.assertNotIn("hash", devs[0])
                self.assertIsNotNone(app.devices.verify(body["token"]))
                await c.rpc("devices.revoke", {"id": devs[0]["id"]})
                self.assertIsNone(app.devices.verify(body["token"]))                     # 撤销后令牌立即失效
            finally:
                c.w.close()
                server.close()


if __name__ == "__main__":
    unittest.main()
