import subprocess
import unittest
import test_engineering as engineering_tests
from bridge.agent import sandbox
from bridge.filesystem.workspace import WorkspaceError

class SandboxBoundaries(unittest.TestCase):
    def setUp(self):
        engineering_tests.EngineeringRecords.setUp(self)
        self.data = self.ws.checkpoints.base.parent
        self.git("init")
        (self.ws.primary / "a.txt").write_text("before\n")
        self.git("add", ".")
        self.git("-c", "user.name=Koide test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline")
    def tearDown(self): engineering_tests.EngineeringRecords.tearDown(self)
    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.ws.primary, capture_output=True, check=True)
    def test_dirty_source_rejected_without_modifying_it(self):
        (self.ws.primary / "a.txt").write_text("draft\n")
        with self.assertRaises(WorkspaceError): sandbox.create(self.ws, self.data)
        self.assertEqual((self.ws.primary / "a.txt").read_text(), "draft\n")
    def test_apply_requires_current_validation_and_rejects_conflicts(self):
        box = sandbox.create(self.ws, self.data)
        child, _ = sandbox.open_workspace(self.ws, self.data, box["id"])
        child.write("a.txt", "after\n", child.hash("a.txt")["revision"])
        snapshot = sandbox.snapshot(child)
        with self.assertRaises(WorkspaceError): sandbox.apply(self.ws, self.data, box["id"], snapshot["revision"])
        task = child.checkpoints.start_task("验证", "agent")
        child.checkpoints.add_event(task["id"], "build_ok", "验证通过", workspace_revision=snapshot["revision"])
        (self.ws.primary / "a.txt").write_text("external\n")
        with self.assertRaises(WorkspaceError): sandbox.apply(self.ws, self.data, box["id"], snapshot["revision"])
        self.assertEqual((self.ws.primary / "a.txt").read_text(), "external\n")
        child.write("a.txt", "new change\n", child.hash("a.txt")["revision"])
        self.assertFalse(sandbox.inspect(self.ws, self.data, box["id"])["validated"])
