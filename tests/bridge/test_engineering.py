import tempfile
import unittest
from pathlib import Path
from bridge.agent import engineering
from bridge.filesystem.workspace import Workspace, WorkspaceError
from bridge.checkpoint.store import CheckpointStore
from bridge.filesystem.trash import Trash
from bridge.security.policy import HardPolicy

class EngineeringRecords(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        root = base / "project"; root.mkdir()
        self.ws = Workspace([root], CheckpointStore(base / "data" / "checkpoint"), Trash(base / "data" / "trash"), HardPolicy(base / "service", base / "data"))
        self.task = self.ws.checkpoints.start_task("修复", "agent")["id"]
    def tearDown(self): self.temp.cleanup()
    def test_revision_conflict_preserves_pins(self):
        engineering.put(self.ws, "context", {"pins": [{"content": "原稿"}]}, "absent")
        with self.assertRaises(WorkspaceError): engineering.put(self.ws, "context", {"pins": []}, "absent")
        self.assertEqual(engineering.get(self.ws, "context")["value"]["pins"][0]["content"], "原稿")
    def test_plan_changes_are_journaled_and_cycles_rejected(self):
        engineering.execute(self.ws, self.task, "task_plan", {"nodes": [{"id":"a","title":"读取","kind":"inspect"}]}, "p1")
        engineering.execute(self.ws, self.task, "task_plan", {"nodes": [{"id":"b","title":"验证","kind":"validate"}]}, "p2")
        self.assertEqual(len([e for e in self.ws.checkpoints.load(self.task)["events"] if e["type"] == "plan"]), 2)
        with self.assertRaises(WorkspaceError): engineering.execute(self.ws, self.task, "task_plan", {"nodes":[{"id":"c","title":"错误","kind":"inspect","depends_on":["c"]}]}, "p3")
    def test_evidence_must_reference_real_results(self):
        with self.assertRaises(WorkspaceError): engineering.execute(self.ws, self.task, "investigation_record", {"kind":"conclusion","statement":"已修复","evidence":["imaginary"]}, "r")
        self.ws.checkpoints.add_event(self.task, "tool_result", "测试失败", call_id="real", state="error")
        result = engineering.execute(self.ws, self.task, "investigation_record", {"kind":"conclusion","statement":"假设不成立","outcome":"rejected","evidence":["real"]}, "r")
        self.assertEqual(result["record"]["evidence"], ["real"])
    def test_resume_history_scope_and_path_traversal(self):
        unrelated = self.ws.checkpoints.start_task("另一任务")["id"]
        with self.assertRaises(WorkspaceError): engineering.execute(self.ws, self.task, "task_history", {"task_id":unrelated}, "h")
        with self.assertRaises(ValueError): self.ws.checkpoints.load("../secrets")
    def test_malformed_metadata_does_not_replace_valid_context(self):
        saved = engineering.put(self.ws, "context", {"pins": [{"content": "草稿"}]}, "absent")
        with self.assertRaises(WorkspaceError): engineering.put(self.ws, "context", {"pins": [None]}, saved["revision"])
        self.assertEqual(engineering.get(self.ws, "context")["revision"], saved["revision"])
