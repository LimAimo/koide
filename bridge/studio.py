"""项目创作工作台。所有项目数据和试验修改均经过 Workspace。"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .checkpoint.store import revision_of
from .filesystem.workspace import Ctx, Workspace, WorkspaceError

STATE_PATH = ".koide/studio.json"
SKIP = {".koide", ".git", ".diffusion", "node_modules", "vendor", "target", "dist", "build", ".gradle", ".idea", "__pycache__", ".venv", "venv", ".next", ".nuxt", "coverage"}
MAX_FILES = 5000
MAX_TOTAL = 128 * 1024 * 1024
MAX_STATE = 2 * 1024 * 1024


def _baseline_revision(baseline: dict) -> str:
    canonical = json.dumps(baseline, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _safe_part(part: str) -> bool:
    lower = part.lower()
    return (lower not in SKIP and lower not in {".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", "credentials", "credentials.json", "id_rsa", "id_ecdsa", "id_ed25519", ".netrc", ".pgpass", ".npmrc", ".pypirc", "service-account.json"}
            and lower != ".env" and not lower.startswith(".env.") and not lower.endswith((".pem", ".key", ".p12", ".pfx"))
            and not lower.startswith((".diffusion-tmp-", ".koide-tmp-")))


def _id(value: str) -> str:
    if not isinstance(value, str) or len(value) != 32 or not all(c in "0123456789abcdef" for c in value):
        raise WorkspaceError("BAD_EXPERIMENT", "试验编号无效")
    return value


class Studio:
    def __init__(self, workspace: Workspace):
        self.ws = workspace

    @property
    def workspace_key(self) -> str:
        return hashlib.sha256(str(self.ws.primary).encode("utf-8")).hexdigest()[:16]

    def _json(self, path: str) -> tuple[dict, str]:
        file = self.ws.read(path)
        try:
            value = json.loads(file.get("content", ""))
        except (TypeError, ValueError):
            raise WorkspaceError("STUDIO_INVALID_DATA", f"{path} 不是有效 JSON；请先恢复或修复文件")
        if not isinstance(value, dict):
            raise WorkspaceError("STUDIO_INVALID_DATA", "工作台数据必须是 JSON 对象")
        return value, file["revision"]

    def read(self) -> dict:
        try:
            data, revision = self._json(STATE_PATH)
        except WorkspaceError as error:
            if error.code != "NOT_FOUND":
                raise
            data, revision = {}, "absent"
        return {"data": data, "revision": revision, "path": STATE_PATH, "workspace_key": self.workspace_key}

    def write(self, data: dict, base_revision: str | None = None) -> dict:
        if not isinstance(data, dict):
            raise WorkspaceError("BAD_PARAMS", "工作台数据必须是 JSON 对象")
        if not isinstance(base_revision, str) or not base_revision:
            raise WorkspaceError("NEEDS_REVISION", "保存工作台需要基础版本，请先读取")
        try:
            text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        except (ValueError, TypeError):
            raise WorkspaceError("BAD_PARAMS", "工作台数据无法保存为 JSON")
        if len(text.encode("utf-8")) > MAX_STATE:
            raise WorkspaceError("TOO_LARGE", "工作台数据超过 2 MiB；图片应使用附件文件")
        task = self.ws.checkpoints.start_task("保存项目工作台", "studio")
        try:
            result = self.ws.write(STATE_PATH, text, base_revision, Ctx("user", task["id"]))
            self.ws.checkpoints.finish_task(task["id"], "done", "项目工作台已保存")
        except Exception:
            self.ws.checkpoints.finish_task(task["id"], "error", "保存失败，原有数据保持可恢复")
            raise
        return {**result, "data": data, "task_id": task["id"], "workspace_key": self.workspace_key}

    def _scan(self, directory: str = ".") -> dict[str, dict]:
        root = self.ws.resolve(directory)
        if root.is_symlink() or not root.is_dir():
            raise WorkspaceError("BAD_EXPERIMENT", "试验文件夹不存在或不是普通目录")
        files: dict[str, dict] = {}
        total = 0
        for current, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if _safe_part(d) and not (Path(current) / d).is_symlink())
            for name in sorted(names):
                raw = Path(current) / name
                if not _safe_part(name) or raw.is_symlink() or not raw.is_file():
                    continue
                relative = raw.relative_to(root).as_posix()
                display = self.ws.display(raw)
                resolved = self.ws.resolve(display)
                if self.ws.policy.check_path(resolved, "read") is not None:
                    continue
                # Never follow a link swapped into the tree while enumerating.
                if raw.is_symlink() or resolved != raw:
                    raise WorkspaceError("OUTSIDE_WORKSPACE", "试验中出现了符号链接，请移除后重试")
                size = resolved.stat().st_size
                total += size
                if len(files) >= MAX_FILES or total > MAX_TOTAL:
                    raise WorkspaceError("TOO_LARGE", "工作台快照最多支持 5000 个文件、128 MiB，请排除生成物或拆分项目")
                data = resolved.read_bytes()
                files[relative] = {"revision": revision_of(data), "size": len(data), "data": data, "path": display}
        return files

    def revision(self) -> dict:
        files = self._scan()
        digest = hashlib.sha256()
        for path, entry in sorted(files.items()):
            digest.update(path.encode("utf-8") + b"\0" + entry["revision"].encode("ascii") + b"\n")
        return {"revision": "sha256:" + digest.hexdigest(), "files_count": len(files)}

    def inspect_launch(self) -> dict:
        candidates, notices, manifests = [], [], []
        files = self._scan()
        for path, entry in files.items():
            if path.count("/") > 3:
                continue
            name = Path(path).name
            cwd = str(Path(path).parent).replace("\\", "/")
            if name == "package.json":
                try:
                    package = json.loads(entry["data"])
                except (ValueError, UnicodeDecodeError):
                    notices.append(f"{path} 的 JSON 无效")
                    continue
                if not isinstance(package, dict):
                    notices.append(f"{path} 的内容必须是 JSON 对象")
                    continue
                manifests.append({"path": path, "kind": "node", "revision": entry["revision"]})
                for script, command in package.get("scripts", {}).items() if isinstance(package.get("scripts"), dict) else []:
                    if not isinstance(command, str) or not isinstance(script, str) or len(script) > 120:
                        continue
                    kind = "run" if script in {"dev", "start", "serve", "preview"} else "verify" if script in {"test", "lint", "check", "typecheck", "build"} else "script"
                    # Quote the script name, never interpolate script body into a shell command.
                    if not all(c.isalnum() or c in "_-:." for c in script):
                        notices.append(f"{path} 的脚本名 {script} 需要在终端手动运行")
                        continue
                    candidates.append({"id": f"{path}:{script}", "label": f"{cwd} · {script}", "command": f"pnpm run {script}", "cwd": cwd, "kind": kind, "source": path, "script": command, "needs_install": not (self.ws.primary / cwd / "node_modules").is_dir()})
            elif name == "Cargo.toml":
                manifests.append({"path": path, "kind": "rust", "revision": entry["revision"]})
                for command, kind in [("cargo run", "run"), ("cargo test", "verify"), ("cargo check", "verify")]:
                    candidates.append({"id": f"{path}:{command}", "label": f"{cwd} · {command}", "command": command, "cwd": cwd, "kind": kind, "source": path})
            elif name in {"pyproject.toml", "requirements.txt", "manage.py"}:
                manifests.append({"path": path, "kind": "python", "revision": entry["revision"]})
                if name == "manage.py":
                    candidates.append({"id": f"{path}:server", "label": f"{cwd} · Django 开发服务器", "command": "python manage.py runserver", "cwd": cwd, "kind": "run", "source": path})
                elif name == "pyproject.toml":
                    candidates.append({"id": f"{path}:tests", "label": f"{cwd} · Python 测试", "command": "python -m unittest discover -v", "cwd": cwd, "kind": "verify", "source": path})
        tools = {tool: bool(shutil.which(tool)) for tool in ("pnpm", "node", "cargo", "python", "git")}
        for candidate in candidates:
            candidate["name"] = candidate["label"]
        return {"commands": candidates, "candidates": candidates, "manifests": manifests, "tools": tools, "environment": [{"name": name, "available": available, "detail": "已安装" if available else "未在 PATH 中找到"} for name, available in tools.items()], "project_type": " / ".join(sorted({m["kind"] for m in manifests})) or "未知项目", "notices": notices, "auto_install": False, "capabilities": {"launch": True, "preview": True}}

    def experiments_list(self) -> dict:
        root = self.ws.resolve(".koide/experiments")
        items = []
        if root.is_dir():
            for item in sorted(root.iterdir()):
                if item.is_symlink() or not item.is_dir() or len(item.name) != 32:
                    continue
                try:
                    data = self._verified_manifest(_id(item.name))
                    items.append({k: v for k, v in data.items() if k != "baseline"})
                except WorkspaceError:
                    continue
        items.sort(key=lambda item: item.get("created_at", 0), reverse=True)
        return {"items": items, "experiments": items, "capabilities": {"isolated": True, "apply": True}}

    def experiments_create(self, name: str = "新试验", baseline_id: str | None = None) -> dict:
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise WorkspaceError("BAD_PARAMS", "试验名称须为 1 到 120 个字符")
        # A second variant can reuse the immutable original snapshot of the first variant.
        if baseline_id:
            source = self._verified_manifest(_id(baseline_id))
            files = self._scan(f".koide/experiments/{baseline_id}/base")
            expected = source.get("baseline", {})
            if {p: e["revision"] for p, e in files.items()} != expected:
                raise WorkspaceError("CONFLICT", "试验基线已改变，不能从不一致的基线创建方案")
        else:
            files = self._scan()
        experiment_id = uuid.uuid4().hex
        prefix = f".koide/experiments/{experiment_id}"
        task = self.ws.checkpoints.start_task(f"创建试验：{name.strip()}", "studio")
        ctx = Ctx("user", task["id"])
        try:
            self.ws.create(prefix + "/work", "dir", ctx=ctx)
            self.ws.create(prefix + "/base", "dir", ctx=ctx)
            for path, entry in files.items():
                self.ws.write_bytes(prefix + "/base/" + path, entry["data"], "absent", ctx)
                self.ws.write_bytes(prefix + "/work/" + path, entry["data"], "absent", ctx)
            baseline = {p: e["revision"] for p, e in files.items()}
            manifest = {"id": experiment_id, "name": name.strip(), "created_at": time.time(), "workspace_path": prefix + "/work", "baseline": baseline, "baseline_revision": _baseline_revision(baseline), "files_count": len(files), "status": "ready", "baseline_id": baseline_id, "creation_task_id": task["id"]}
            self.ws.write(prefix + "/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2), "absent", ctx)
            self.ws.checkpoints.finish_task(task["id"], "done", "已创建隔离试验；依赖需要单独安装")
        except Exception:
            self.ws.checkpoints.finish_task(task["id"], "error", "试验创建失败，可通过检查点恢复")
            raise
        return {**{k: v for k, v in manifest.items() if k != "baseline"}, "absolute_path": str(self.ws.primary / manifest["workspace_path"]), "task_id": task["id"]}

    def _verified_manifest(self, experiment_id: str) -> dict:
        path = f".koide/experiments/{_id(experiment_id)}/manifest.json"
        manifest, revision = self._json(path)
        creation_id = manifest.get("creation_task_id")
        if not isinstance(creation_id, str) or not 1 <= len(creation_id) <= 128 or not all(c.isalnum() or c in "_-" for c in creation_id):
            raise WorkspaceError("STUDIO_INVALID_DATA", "试验的创建记录编号无效")
        try:
            task = self.ws.checkpoints.load(creation_id)
        except (KeyError, ValueError, TypeError):
            raise WorkspaceError("STUDIO_INVALID_DATA", "试验缺少可信创建记录，请重新创建")
        if manifest.get("id") != experiment_id or not any(event.get("path") == path and event.get("after_rev") == revision for event in task.get("events", []) if event.get("type") == "edit"):
            raise WorkspaceError("CONFLICT", "试验清单已被修改，不能信任其基线，请重新创建")
        manifest["workspace_path"] = f".koide/experiments/{experiment_id}/work"
        manifest["absolute_path"] = str(self.ws.resolve(manifest["workspace_path"]))
        manifest["baseline_revision"] = _baseline_revision(manifest["baseline"])
        return manifest

    def _experiment(self, experiment_id: str) -> tuple[dict, dict, dict]:
        experiment_id = _id(experiment_id)
        manifest = self._verified_manifest(experiment_id)
        baseline = manifest.get("baseline")
        if not isinstance(baseline, dict) or any(not isinstance(path, str) or not isinstance(rev, str) for path, rev in baseline.items()):
            raise WorkspaceError("STUDIO_INVALID_DATA", "试验基线无效")
        base = self._scan(f".koide/experiments/{experiment_id}/base")
        if {p: e["revision"] for p, e in base.items()} != baseline:
            raise WorkspaceError("CONFLICT", "试验原始基线已经被修改，无法安全比较或应用")
        return manifest, base, self._scan(f".koide/experiments/{experiment_id}/work")

    def experiments_diff(self, experiment_id: str) -> dict:
        manifest, base, work = self._experiment(experiment_id)
        return self._differences(experiment_id, manifest, base, work, self._scan())

    @staticmethod
    def _differences(experiment_id: str, manifest: dict, base: dict, work: dict, current: dict) -> dict:
        changes = []
        text_budget = 2 * 1024 * 1024
        for path in sorted(set(base) | set(work)):
            before, after = base.get(path), work.get(path)
            br, ar = (before or {}).get("revision", "absent"), (after or {}).get("revision", "absent")
            if br == ar:
                continue
            item = {"path": path, "kind": "create" if before is None else "delete" if after is None else "modify", "before_revision": br, "after_revision": ar, "current_revision": (current.get(path) or {}).get("revision", "absent"), "conflict": (current.get(path) or {}).get("revision", "absent") != br}
            try:
                bt, at = (before or {}).get("data", b"").decode("utf-8"), (after or {}).get("data", b"").decode("utf-8")
                if "\0" in bt or "\0" in at:
                    raise UnicodeError()
                before_limit = min(100000, text_budget // 12)
                bt_short, at_short = bt[:before_limit], at[:before_limit]
                item["before"], item["after"] = bt_short, at_short
                item["diff"] = "".join(difflib.unified_diff(bt_short.splitlines(True), at_short.splitlines(True), fromfile="基线/" + path, tofile="方案/" + path))[:before_limit]
                item["content_truncated"] = len(bt) > len(bt_short) or len(at) > len(at_short)
                text_budget = max(0, text_budget - len((bt_short + at_short + item["diff"]).encode("utf-8")))
            except UnicodeError:
                item["binary"] = True
                item["before"], item["after"] = "二进制文件" if before else "", "二进制文件" if after else ""
            item["status"] = item["kind"]
            changes.append(item)
        return {"id": experiment_id, "name": manifest.get("name", "试验"), "changes": changes, "files": changes, "has_conflicts": any(c["conflict"] for c in changes), "baseline_verified": True}

    def experiments_apply(self, experiment_id: str) -> dict:
        with self.ws._lock:
            manifest, base, work = self._experiment(experiment_id)
            differences = self._differences(experiment_id, manifest, base, work, self._scan())
            if differences["has_conflicts"]:
                raise WorkspaceError("CONFLICT", "主项目已偏离试验基线，请保留两边修改后重新试验", conflicts=[c["path"] for c in differences["changes"] if c["conflict"]])
            # Resolve every target under policy before the first mutation. No sensitive-file bypass.
            for change in differences["changes"]:
                verdict = self.ws.policy.check_path(self.ws.resolve(change["path"], "write"), "write")
                if verdict:
                    raise WorkspaceError("POLICY_DENIED", verdict.reason)
            task = self.ws.checkpoints.start_task(f"应用试验：{manifest.get('name', '试验')}", "studio")
            ctx = Ctx("user", task["id"])
            try:
                for change in differences["changes"]:
                    path = change["path"]
                    if self.ws.hash(path)["revision"] != change["before_revision"]:
                        raise WorkspaceError("CONFLICT", f"{path} 在应用期间被修改")
                    if change["kind"] == "delete":
                        self.ws.delete(path, ctx)
                    else:
                        self.ws.write_bytes(path, work[path]["data"], change["before_revision"], ctx)
                self.ws.checkpoints.finish_task(task["id"], "done", f"已应用 {len(differences['changes'])} 个文件修改")
            except Exception:
                self.ws.checkpoints.finish_task(task["id"], "error", "应用中止，已应用部分可通过检查点恢复")
                raise
            return {"id": experiment_id, "applied": len(differences["changes"]), "task_id": task["id"], "changes": differences["changes"]}
