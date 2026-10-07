import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bridge.studio import Studio
from bridge.checkpoint.store import CheckpointStore
from bridge.filesystem.trash import Trash
from bridge.filesystem.workspace import Workspace, WorkspaceError
from bridge.security.policy import HardPolicy


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        project = self.root / "project"
        project.mkdir()
        data = self.root / "data"
        data.mkdir()
        self.ws = Workspace([project], CheckpointStore(data / "cp"), Trash(data / "trash"), HardPolicy(self.root / "bridge", data))
        self.studio = Studio(self.ws)

    def tearDown(self):
        self.temp.cleanup()

    def test_metadata_revision_and_restore(self):
        self.assertEqual(self.studio.read()["workspace_key"], self.studio.workspace_key)
        self.assertEqual(self.studio.read()["revision"], "absent")
        with self.assertRaises(WorkspaceError):
            self.studio.write({"scene": "rain"})
        result = self.studio.write({"scene": "rain"}, "absent")
        self.assertEqual(result["workspace_key"], self.studio.workspace_key)
        self.assertEqual(self.studio.read()["data"], {"scene": "rain"})
        with self.assertRaises(WorkspaceError) as error:
            self.studio.write({"scene": "sea"}, "absent")
        self.assertEqual(error.exception.code, "CONFLICT")
        self.ws.revert_task(result["task_id"])
        self.assertEqual(self.studio.read()["revision"], "absent")

    def test_corrupt_metadata_is_not_silently_discarded(self):
        self.ws.write(".koide/studio.json", "broken")
        with self.assertRaises(WorkspaceError) as error:
            self.studio.read()
        self.assertEqual(error.exception.code, "STUDIO_INVALID_DATA")

    def test_revision_ignores_generated_metadata_and_secrets(self):
        self.ws.write("src/a.js", "one")
        initial = self.studio.revision()
        self.ws.write("node_modules/a.js", "generated")
        self.ws.write(".env", "TOKEN=secret")
        self.ws.write(".npmrc", "_authToken=secret")
        self.studio.write({"scene": "sea"}, "absent")
        self.assertEqual(self.studio.revision(), initial)
        self.ws.write("src/a.js", "two")
        self.assertNotEqual(self.studio.revision(), initial)

    def test_launch_uses_scripts_as_quoted_identifiers_not_shell_bodies(self):
        self.ws.write("package.json", json.dumps({"scripts": {"dev": "vite --host", "danger;echo": "whatever", "test": "node --test"}}))
        result = self.studio.inspect_launch()
        self.assertEqual({command["command"] for command in result["commands"]}, {"pnpm run dev", "pnpm run test"})
        self.assertFalse(result["auto_install"])

    def test_experiment_same_baseline_conflict_apply_delete_restore(self):
        self.ws.write("a.js", "old")
        self.ws.write("remove.txt", "restore me")
        first = self.studio.experiments_create("方案 A")
        second = self.studio.experiments_create("方案 B", first["id"])
        self.assertEqual(first["baseline_revision"], second["baseline_revision"])
        self.assertTrue(Path(self.studio.experiments_list()["experiments"][0]["absolute_path"]).is_absolute())
        self.ws.write(first["workspace_path"] + "/a.js", "new")
        self.ws.delete(first["workspace_path"] + "/remove.txt")
        self.ws.write(first["workspace_path"] + "/added.bin", "added")
        self.assertEqual(self.ws.read(second["workspace_path"] + "/a.js")["content"], "old")
        self.ws.write("a.js", "user edit")
        with self.assertRaises(WorkspaceError) as error:
            self.studio.experiments_apply(first["id"])
        self.assertEqual(error.exception.code, "CONFLICT")
        self.assertEqual(self.ws.read("remove.txt")["content"], "restore me")
        self.ws.write("a.js", "old")
        result = self.studio.experiments_apply(first["id"])
        self.assertEqual(result["applied"], 3)
        self.assertEqual(self.ws.read("a.js")["content"], "new")
        self.assertTrue(self.ws.trash.list())
        self.ws.revert_task(result["task_id"])
        self.assertEqual(self.ws.read("a.js")["content"], "old")
        self.assertEqual(self.ws.read("remove.txt")["content"], "restore me")
        self.assertEqual(self.ws.hash("added.bin")["revision"], "absent")

    def test_tampered_baseline_and_path_escape_rejected(self):
        self.ws.write("a.js", "one")
        experiment = self.studio.experiments_create("方案 A")
        self.ws.write(f".koide/experiments/{experiment['id']}/base/a.js", "tampered")
        with self.assertRaises(WorkspaceError) as error:
            self.studio.experiments_diff(experiment["id"])
        self.assertEqual(error.exception.code, "CONFLICT")
        with self.assertRaises(WorkspaceError):
            self.studio.experiments_diff("../escape")

    def test_tampering_both_manifest_and_baseline_cannot_forge_snapshot(self):
        self.ws.write("a.js", "one")
        experiment = self.studio.experiments_create("方案 A")
        prefix = f".koide/experiments/{experiment['id']}"
        changed = self.ws.write(prefix + "/base/a.js", "tampered")
        manifest = json.loads(self.ws.read(prefix + "/manifest.json")["content"])
        manifest["baseline"]["a.js"] = changed["revision"]
        self.ws.write(prefix + "/manifest.json", json.dumps(manifest))
        with self.assertRaises(WorkspaceError) as error:
            self.studio.experiments_apply(experiment["id"])
        self.assertEqual(error.exception.code, "CONFLICT")
        self.assertEqual(self.ws.read("a.js")["content"], "one")


if __name__ == "__main__":
    unittest.main()
