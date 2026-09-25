import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bridge.git import ops


@unittest.skipUnless(shutil.which("git"), "需要 git")
class GitOps(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        for c in (["init", "-q", "-b", "main"], ["config", "user.name", "测试"], ["config", "user.email", "t@example.com"]):
            subprocess.run(["git", *c], cwd=self.root, check=True)

    def tearDown(self):
        self.td.cleanup()

    def test_not_a_repo(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(ops.status(Path(d)), {"is_repo": False})

    def test_full_flow(self):
        (self.root / "a.py").write_text("print(1)\n")
        st = ops.status(self.root)
        self.assertTrue(st["is_repo"])
        self.assertEqual(st["branch"], "main")
        self.assertEqual([(f["path"], f["index"]) for f in st["files"]], [("a.py", "?")])
        self.assertIn("+print(1)", ops.diff(self.root, "a.py"))               # 未跟踪文件也能看差异
        ops.stage(self.root, ["a.py"])
        self.assertEqual(ops.status(self.root)["files"][0]["index"], "A")
        ops.unstage(self.root, ["a.py"])
        self.assertEqual(ops.status(self.root)["files"][0]["index"], "?")
        ops.stage(self.root, ["a.py"])
        h = ops.commit(self.root, "第一次提交")
        self.assertTrue(h)
        self.assertEqual(ops.status(self.root)["files"], [])
        (self.root / "a.py").write_text("print(2)\n")
        self.assertIn("-print(1)", ops.diff(self.root, "a.py"))
        ops.stage(self.root, ["a.py"])
        self.assertIn("+print(2)", ops.diff(self.root, "a.py", staged=True))
        ops.commit(self.root, "改成 2")
        log = ops.log(self.root)
        self.assertEqual([c["subject"] for c in log], ["改成 2", "第一次提交"])
        self.assertEqual(ops.blame(self.root, "a.py")[0]["author"], "测试")
        ops.checkout(self.root, "feature", create=True)
        self.assertEqual({b["name"]: b["current"] for b in ops.branches(self.root)}, {"main": False, "feature": True})
        (self.root / "a.py").write_text("坏了\n")
        ops.discard_tracked(self.root, "a.py")
        self.assertEqual((self.root / "a.py").read_text(), "print(2)\n")

    def test_reset_helpers_and_tree_blobs(self):
        (self.root / "a.txt").write_text("one\n")
        ops.stage(self.root, ["a.txt"]); first = ops.commit(self.root, "one")
        (self.root / "a.txt").write_text("two\n")
        ops.stage(self.root, ["a.txt"]); second = ops.commit(self.root, "two")
        full_first = ops.resolve_commit(self.root, first)
        self.assertEqual(len(full_first), 40)
        tree = ops.tree(self.root, first)
        self.assertEqual(tree["a.txt"]["type"], "blob")
        self.assertEqual(ops.blob(self.root, tree["a.txt"]["sha"]), b"one\n")
        ops.reset_soft(self.root, first)
        self.assertEqual((self.root / "a.txt").read_text(), "two\n")
        self.assertEqual(ops.resolve_commit(self.root, "HEAD"), full_first)
        ops.reset_mixed(self.root, second)
        self.assertEqual(ops.resolve_commit(self.root, "HEAD"), ops.resolve_commit(self.root, second))

    def test_friendly_errors(self):
        with self.assertRaises(ops.GitError) as c:
            ops.commit(self.root, "没有东西")
        self.assertIn("没有", str(c.exception))
        with self.assertRaises(ops.GitError):
            ops.commit(self.root, "  ")
        with self.assertRaises(ops.GitError):
            ops.checkout(self.root, "--force")


if __name__ == "__main__":
    unittest.main()
