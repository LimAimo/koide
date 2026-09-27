import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from bridge.checkpoint.store import CheckpointStore, revision_of
from bridge.filesystem.trash import Trash
from bridge.filesystem.workspace import Ctx, Workspace, WorkspaceError, apply_edits
from bridge.security.policy import HardPolicy


def make_ws(tmp: Path):
    proj = tmp / "proj"
    proj.mkdir()
    data = tmp / "data"
    data.mkdir()
    policy = HardPolicy(bridge_dir=Path(__file__).resolve().parents[2] / "bridge", data_dir=data)
    ws = Workspace([proj], CheckpointStore(data / "cp"), Trash(data / "trash"), policy)
    return ws, proj


class PatchTests(unittest.TestCase):
    def test_range_edit_is_one_based_end_exclusive(self):
        out = apply_edits("hello world\nsecond", [
            {"range": {"start": {"line": 1, "column": 7}, "end": {"line": 1, "column": 12}}, "new_text": "there"}])
        self.assertEqual(out, "hello there\nsecond")

    def test_multi_edits_address_original_text(self):
        out = apply_edits("a b c", [{"old_text": "a", "new_text": "AAA"}, {"old_text": "c", "new_text": "C"}])
        self.assertEqual(out, "AAA b C")

    def test_ambiguous_and_missing_match(self):
        with self.assertRaises(WorkspaceError) as c:
            apply_edits("x x", [{"old_text": "x", "new_text": "y"}])
        self.assertEqual(c.exception.code, "AMBIGUOUS_MATCH")
        with self.assertRaises(WorkspaceError) as c:
            apply_edits("abc", [{"old_text": "zzz", "new_text": "y"}])
        self.assertEqual(c.exception.code, "NO_MATCH")
        self.assertEqual(apply_edits("x x", [{"old_text": "x", "new_text": "y", "replace_all": True}]), "y y")

    def test_overlap_rejected(self):
        with self.assertRaises(WorkspaceError) as c:
            apply_edits("abcdef", [{"old_text": "abcd", "new_text": ""}, {"old_text": "cdef", "new_text": ""}])
        self.assertEqual(c.exception.code, "OVERLAPPING_EDITS")

    def test_crlf_preserved(self):
        out = apply_edits("a\r\nb\r\n", [{"old_text": "b", "new_text": "B"}])
        self.assertEqual(out, "a\r\nB\r\n")

    def test_code_containing_terminator_like_text(self):
        payload = "<<<END>>>\n```\n</tool_call>\nEND_TOOL"
        self.assertEqual(apply_edits("X", [{"old_text": "X", "new_text": payload}]), payload)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.ws, self.proj = make_ws(self.tmp)
        self.changes = []
        self.ws.listeners.append(self.changes.append)

    def tearDown(self):
        self._td.cleanup()

    def test_sandbox_blocks_escape_and_symlink_escape(self):
        (self.tmp / "secret.txt").write_text("nope")
        with self.assertRaises(WorkspaceError) as c:
            self.ws.read("../secret.txt")
        self.assertEqual(c.exception.code, "OUTSIDE_WORKSPACE")
        os.symlink(self.tmp / "secret.txt", self.proj / "link.txt")
        with self.assertRaises(WorkspaceError) as c:
            self.ws.read("link.txt")
        self.assertEqual(c.exception.code, "OUTSIDE_WORKSPACE")

    def test_write_read_revision_and_conflict(self):
        r = self.ws.write("a.txt", "one")
        self.assertEqual(r["revision"], revision_of(b"one"))
        (self.proj / "a.txt").write_text("user typed something")   # external change
        with self.assertRaises(WorkspaceError) as c:
            self.ws.patch("a.txt", r["revision"], [{"old_text": "one", "new_text": "two"}])
        self.assertEqual(c.exception.code, "CONFLICT")
        self.assertEqual((self.proj / "a.txt").read_text(), "user typed something")

    def test_patch_requires_revision(self):
        self.ws.write("a.txt", "one")
        with self.assertRaises(WorkspaceError) as c:
            self.ws.patch("a.txt", "", [{"old_text": "one", "new_text": "two"}])
        self.assertEqual(c.exception.code, "NEEDS_REVISION")

    def test_change_event_carries_before_after(self):
        self.ws.write("a.txt", "one")
        rev = self.ws.read("a.txt")["revision"]
        self.ws.patch("a.txt", rev, [{"old_text": "one", "new_text": "two"}], Ctx("agent"))
        ch = self.changes[-1]
        self.assertEqual((ch.kind, ch.before_text, ch.after_text, ch.actor), ("modify", "one", "two", "agent"))

    def test_agent_checkpoint_edit_keeps_tool_call_id(self):
        task = self.ws.checkpoints.start_task("trace edit", "agent")
        self.ws.write("trace.txt", "hello", "absent", Ctx("agent", task["id"], "call_trace_123"))
        saved = self.ws.checkpoints.load_task(task["id"])
        edit = next(e for e in saved["events"] if e["type"] == "edit")
        self.assertEqual(edit["call_id"], "call_trace_123")

    def test_delete_goes_to_trash_and_restores(self):
        self.ws.write("a.txt", "keep me")
        res = self.ws.delete("a.txt")
        self.assertFalse((self.proj / "a.txt").exists())
        self.assertEqual(len(self.ws.trash.list()), 1)
        self.ws.restore_from_trash(res["trash_id"])
        self.assertEqual((self.proj / "a.txt").read_text(), "keep me")

    def test_transactional_write_commit_and_abort(self):
        self.ws.write("big.txt", "original")
        w = self.ws.begin_write("big.txt")["write_id"]
        self.ws.write_chunk(w, 0, "hello ")
        self.ws.write_chunk(w, 1, "world")
        self.assertEqual((self.proj / "big.txt").read_text(), "original")   # untouched before commit
        sha = hashlib.sha256(b"hello world").hexdigest()
        self.ws.commit_write(w, 11, sha)
        self.assertEqual((self.proj / "big.txt").read_text(), "hello world")

        w = self.ws.begin_write("big.txt")["write_id"]
        self.ws.write_chunk(w, 0, "partial")
        self.ws.abort_write(w)                                              # model died mid-stream
        self.assertEqual((self.proj / "big.txt").read_text(), "hello world")
        self.assertEqual([p for p in os.listdir(self.proj) if p.startswith(".diffusion-tmp")], [])

    def test_transactional_write_rejects_bad_sequence_and_hash(self):
        w = self.ws.begin_write("x.txt")["write_id"]
        with self.assertRaises(WorkspaceError) as c:
            self.ws.write_chunk(w, 1, "skipped chunk 0")
        self.assertEqual(c.exception.code, "SEQUENCE_ERROR")
        w = self.ws.begin_write("x.txt")["write_id"]
        self.ws.write_chunk(w, 0, "abc")
        with self.assertRaises(WorkspaceError) as c:
            self.ws.commit_write(w, 3, "0" * 64)
        self.assertEqual(c.exception.code, "HASH_MISMATCH")
        self.assertFalse((self.proj / "x.txt").exists())

    def test_task_checkpoint_revert_task_file_and_event(self):
        self.ws.write("a.txt", "A0")
        self.ws.write("b.txt", "B0")
        task = self.ws.checkpoints.start_task("test")["id"]
        ctx = Ctx("agent", task)
        ra = self.ws.read("a.txt")["revision"]
        self.ws.patch("a.txt", ra, [{"old_text": "A0", "new_text": "A1"}], ctx)
        ra2 = self.ws.read("a.txt")["revision"]
        self.ws.patch("a.txt", ra2, [{"old_text": "A1", "new_text": "A2"}], ctx)
        self.ws.write("b.txt", "B1", ctx=ctx)
        self.ws.create("c.txt", content="new", ctx=ctx)
        self.ws.delete("b.txt", ctx)

        m = self.ws.checkpoints.load(task)
        edits = [e for e in m["events"] if e["type"] == "edit"]
        self.assertEqual([e["kind"] for e in edits], ["modify", "modify", "modify", "create", "delete"])

        # single-tool-call revert refuses if later work depends on it
        with self.assertRaises(WorkspaceError) as c:
            self.ws.revert_event(task, edits[0]["seq"])
        self.assertEqual(c.exception.code, "CONFLICT")
        # revert the last modification of a.txt (A2 -> A1)
        self.ws.revert_event(task, edits[1]["seq"])
        self.assertEqual((self.proj / "a.txt").read_text(), "A1")

        # one file back to before the task
        self.ws.revert_file(task, "a.txt")
        self.assertEqual((self.proj / "a.txt").read_text(), "A0")

        # whole task: b.txt restored, c.txt removed
        self.ws.revert_task(task)
        self.assertEqual((self.proj / "b.txt").read_text(), "B0")
        self.assertFalse((self.proj / "c.txt").exists())

    def test_rename_revert(self):
        self.ws.write("old.txt", "data")
        task = self.ws.checkpoints.start_task("rename")["id"]
        self.ws.rename("old.txt", "new.txt", Ctx("agent", task))
        self.assertTrue((self.proj / "new.txt").exists())
        self.ws.revert_task(task)
        self.assertEqual((self.proj / "old.txt").read_text(), "data")
        self.assertFalse((self.proj / "new.txt").exists())

    def test_search_and_tree(self):
        self.ws.write("src/a.py", "def foo():\n    return 1\n")
        self.ws.write("src/b.py", "x = foo()\n")
        r = self.ws.search("foo")
        self.assertEqual(sorted((m["path"], m["line"]) for m in r["matches"]), [("src/a.py", 1), ("src/b.py", 1)])
        names = [n["name"] for n in self.ws.tree(".")]
        self.assertEqual(names, ["src"])

    def test_tree_can_reveal_hidden_metadata_on_request(self):
        (self.proj / ".git").mkdir()
        (self.proj / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        (self.proj / ".DS_Store").write_text("metadata")
        self.ws.write("normal.txt", "ok")

        hidden = [n["name"] for n in self.ws.tree(".")]
        shown = [n["name"] for n in self.ws.tree(".", show_hidden=True)]
        self.assertEqual(hidden, ["normal.txt"])
        self.assertEqual(shown, [".git", ".DS_Store", "normal.txt"])

    def test_hard_policy_protects_bridge_and_data(self):
        bridge_file = Path(__file__).resolve().parents[2] / "bridge" / "filesystem" / "workspace.py"
        self.assertEqual(self.ws.policy.check_path(bridge_file, "write").action, "deny")
        self.assertEqual(self.ws.policy.check_path(self.tmp / "data" / "secrets.json", "read").action, "deny")
        self.assertEqual(self.ws.policy.check_command("rm -rf /").action, "deny")
        self.assertEqual(self.ws.policy.check_command("git push --force origin main").action, "ask")
        self.assertIsNone(self.ws.policy.check_command("npm run build"))


if __name__ == "__main__":
    unittest.main()
