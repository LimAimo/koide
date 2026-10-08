"""工作台批量修改的沙箱、预检、并发任务和整批恢复边界。"""
import tempfile
import unittest
import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace

from bridge.app import BridgeApp
from bridge.checkpoint.store import CheckpointStore
from bridge.filesystem.trash import Trash
from bridge.filesystem.workspace import Workspace, WorkspaceError
from bridge.studio import Studio


class StudioBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        project = self.root / "project"
        project.mkdir()
        self.app = BridgeApp(self.root / "data", self.root / "web", self.root / "bridge")
        self.ws = Workspace([project], CheckpointStore(self.root / "data" / "cp"),
                            Trash(self.root / "data" / "trash"), self.app.policy)
        self.app.workspace = self.ws

    async def asyncTearDown(self):
        self.app.agent = None
        await self.app.shutdown()
        self.temp.cleanup()

    async def apply(self, files):
        return await self.app.rpc_studio_apply_edits({"files": files, "label": "符号重命名"}, None)

    async def test_old_second_revision_never_writes_first_file_or_checkpoint(self):
        a = self.ws.write("a.ts", "first")
        b = self.ws.write("b.ts", "second")
        self.ws.write("b.ts", "外部修改")
        before = self.ws.checkpoints.list_tasks()
        with self.assertRaises(WorkspaceError) as error:
            await self.apply([{"path": "a.ts", "revision": a["revision"], "content": "changed"},
                              {"path": "b.ts", "revision": b["revision"], "content": "wrong"}])
        self.assertEqual(error.exception.code, "REVISION_CONFLICT")
        self.assertEqual(self.ws.read("a.ts")["content"], "first")
        self.assertEqual(self.ws.read("b.ts")["content"], "外部修改")
        self.assertEqual(self.ws.checkpoints.list_tasks(), before)

    async def test_canonical_alias_and_sensitive_ask_are_rejected_before_first_write(self):
        a = self.ws.write("src/a.ts", "original")
        secret = self.ws.write(".env", "TOKEN=secret")
        for target, revision, code in (("src/./a.ts", a["revision"], "BAD_EDIT"),
                                       (".env", secret["revision"], "POLICY_DENIED")):
            before = self.ws.checkpoints.list_tasks()
            with self.assertRaises(WorkspaceError) as error:
                await self.apply([{"path": "src/a.ts", "revision": a["revision"], "content": "changed"},
                                  {"path": target, "revision": revision, "content": "wrong"}])
            self.assertEqual(error.exception.code, code)
            self.assertEqual(self.ws.read("src/a.ts")["content"], "original")
            self.assertEqual(self.ws.read(".env")["content"], "TOKEN=secret")
            self.assertEqual(self.ws.checkpoints.list_tasks(), before)

    async def test_hard_deny_binary_and_workspace_escape_never_apply_first_edit(self):
        a = self.ws.write("a.ts", "original")
        self.ws.write("b.bin", "binary\0data")
        (self.root / "data" / "secret").write_text("private", encoding="utf-8")
        # 私有目录即便误加入工作区，HardPolicy deny 也高于工作区包含关系。
        self.ws.roots.append(self.root / "data")
        for target, expected in (("b.bin", "BAD_EDIT"), (str(self.root / "data" / "secret"), "POLICY_DENIED"), ("../outside", "OUTSIDE_WORKSPACE")):
            with self.assertRaises(WorkspaceError) as error:
                await self.apply([{"path": "a.ts", "revision": a["revision"], "content": "changed"},
                                  {"path": target, "revision": self.ws.hash("b.bin")["revision"], "content": "wrong"}])
            self.assertEqual(error.exception.code, expected)
            self.assertEqual(self.ws.read("a.ts")["content"], "original")
            self.assertEqual(self.ws.checkpoints.list_tasks(), [])

    async def test_agent_running_and_workspace_change_reject_batch(self):
        a = self.ws.write("a.ts", "original")
        files = [{"path": "a.ts", "revision": a["revision"], "content": "changed"}]
        self.app.agent = object()
        with self.assertRaises(WorkspaceError) as error:
            await self.apply(files)
        self.assertEqual(error.exception.code, "AGENT_BUSY")
        self.app.agent = None
        original_call = self.app._call
        async def switch_before_worker(fn, *args, **kwargs):
            self.app.workspace = None
            return await original_call(fn, *args, **kwargs)
        self.app._call = switch_before_worker
        with self.assertRaises(WorkspaceError) as error:
            await self.apply(files)
        self.assertEqual(error.exception.code, "CONFLICT")
        self.assertEqual(self.ws.read("a.ts")["content"], "original")
        self.assertEqual(self.ws.checkpoints.list_tasks(), [])

    async def test_batch_has_checkpoint_edit_events_and_restores_all_files(self):
        a = self.ws.write("a.ts", "export const name = 1;")
        b = self.ws.write("b.ts", "import {name} from './a';")
        result = await self.apply([{"path": "a.ts", "revision": a["revision"], "content": "export const renamed = 1;"},
                                   {"path": "b.ts", "revision": b["revision"], "content": "import {renamed} from './a';"}])
        task = self.ws.checkpoints.load(result["task_id"])
        self.assertEqual(task["status"], "done")
        self.assertEqual(len([event for event in task["events"] if event["type"] == "edit"]), 2)
        self.assertEqual(self.ws.read("a.ts")["content"], "export const renamed = 1;")
        self.assertEqual(self.ws.read("b.ts")["content"], "import {renamed} from './a';")
        self.ws.revert_task(result["task_id"])
        self.assertEqual(self.ws.read("a.ts")["content"], "export const name = 1;")
        self.assertEqual(self.ws.read("b.ts")["content"], "import {name} from './a';")

    async def test_rpc_workspace_key_is_optional_but_mismatch_rejects_before_write(self):
        responses = []
        conn = SimpleNamespace(send=responses.append)
        await self.app.handle_message(conn, json.dumps({"type": "rpc", "id": 1, "method": "studio.read", "params": {}}))
        key = responses[-1]["result"]["workspace_key"]
        self.assertEqual(key, Studio(self.ws).workspace_key)
        await self.app.handle_message(conn, json.dumps({"type": "rpc", "id": 2, "method": "studio.write", "params": {
            "workspace_key": "old-project", "base_revision": "absent", "data": {"wrong": True}}}))
        self.assertEqual(responses[-1]["error"]["code"], "WORKSPACE_CHANGED")
        self.assertEqual(self.ws.hash(".koide/studio.json")["revision"], "absent")
        self.assertEqual(self.ws.checkpoints.list_tasks(), [])
        await self.app.handle_message(conn, json.dumps({"type": "rpc", "id": 3, "method": "studio.write", "params": {
            "workspace_key": key, "base_revision": "absent", "data": {"correct": True}}}))
        self.assertEqual(responses[-1]["result"]["data"], {"correct": True})

    async def test_workspace_transition_rechecks_waiting_agent_request_key(self):
        second = self.root / "second"
        second.mkdir()
        ready, release = threading.Event(), threading.Event()
        def stalled_close():
            ready.set()
            release.wait(3)
        self.app.preview.close_all = stalled_close
        started = []
        async def start(params, conn):
            started.append(self.app.workspace)
            return {"started": True}
        self.app.rpc_agent_start = start
        responses = []
        conn = SimpleNamespace(send=responses.append)
        key = Studio(self.ws).workspace_key
        opening = asyncio.create_task(self.app.handle_message(conn, json.dumps({"type": "rpc", "id": 1,
            "method": "workspace.open", "params": {"path": str(second)}})))
        try:
            self.assertTrue(await asyncio.to_thread(ready.wait, 1))
            starting = asyncio.create_task(self.app.handle_message(conn, json.dumps({"type": "rpc", "id": 2,
                "method": "agent.start", "params": {"workspace_key": key}})))
            await asyncio.sleep(.05)
            self.assertEqual(started, [])
            release.set()
            await asyncio.wait_for(asyncio.gather(opening, starting), 2)
            self.assertEqual(started, [])
            rejected = next(item for item in responses if item["id"] == 2)
            self.assertEqual(rejected["error"]["code"], "WORKSPACE_CHANGED")
            self.assertEqual(self.app.workspace.primary, second.resolve())
        finally:
            release.set()
            await opening


if __name__ == "__main__":
    unittest.main()
