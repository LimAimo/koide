"""Git worktrees with explicit review/apply and Workspace-mediated mutations."""
from __future__ import annotations
import hashlib
import json
import subprocess
import uuid
import threading

_CREATE_LOCK = threading.RLock()
from pathlib import Path
from . import engineering
from ..filesystem.workspace import Workspace, WorkspaceError, Ctx
from ..filesystem.trash import Trash
from ..checkpoint.store import CheckpointStore


def git(root, *args, missing=False):
    try:
        r = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=root, capture_output=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise WorkspaceError("GIT_ERROR", str(e))
    if r.returncode:
        if missing: return None
        raise WorkspaceError("GIT_ERROR", r.stderr.decode("utf-8", "replace")[:1000])
    return r.stdout


def baseline(ws):
    try:
        commit = git(ws.primary, "rev-parse", "HEAD", missing=True)
        if not commit: return None
        return {"commit": commit.decode().strip(), "clean": not git(ws.primary, "status", "--porcelain", "--untracked-files=all").strip()}
    except WorkspaceError:
        return None


def root_for(data_dir, id):
    if not id or not all(c in "0123456789abcdef" for c in id) or len(id) != 32:
        raise WorkspaceError("BAD_SANDBOX", "沙箱编号无效")
    return Path(data_dir).parent / "koide-worktrees" / id


def open_workspace(parent, data_dir, id):
    records = engineering.get(parent, "sandboxes")["value"] or []
    record = next((r for r in records if r["id"] == id), None)
    if not record: raise WorkspaceError("BAD_SANDBOX", "当前项目没有这个沙箱")
    root = root_for(data_dir, id)
    if not root.is_dir() or root.is_symlink(): raise WorkspaceError("BAD_SANDBOX", "沙箱目录不可用")
    key = "sandbox-" + id
    ws = Workspace([root], CheckpointStore(Path(data_dir) / "checkpoints" / key), Trash(Path(data_dir) / "trash" / key), parent.policy)
    return ws, record


def create(ws, data_dir, task_id=None, seq=None):
    with _CREATE_LOCK:
        return _create(ws, data_dir, task_id, seq)


def _create(ws, data_dir, task_id=None, seq=None):
    base = baseline(ws)
    if not base or not base["clean"]: raise WorkspaceError("SANDBOX_DIRTY", "创建沙箱需要已提交且干净的 Git 工作区")
    historical = None
    if task_id:
        historical = ws.checkpoints.load(task_id)
        context = next((e for e in historical["events"] if e["type"] == "context"), {})
        origin = context.get("base_git")
        if not origin or not origin.get("clean"): raise WorkspaceError("HISTORY_UNAVAILABLE", "这项任务没有干净的 Git 起点，不能假装完整恢复历史工作区")
        if seq is None or not 0 <= seq < len(historical["events"]): raise WorkspaceError("BAD_REQUEST", "历史节点不存在")
        base["commit"] = origin["commit"]
    entries = git(ws.primary, "ls-tree", "-r", base["commit"]).decode("utf-8", "replace").splitlines()
    if any(x.startswith(("120000", "160000")) for x in entries): raise WorkspaceError("WORKSPACE_CAPABILITY", "包含符号链接或子模块的仓库暂不支持自动沙箱")
    state = {}
    if historical:
        state = {p: f.get("blob") if f.get("existed") else None for p, f in historical.get("files", {}).items()}
        for event in historical["events"][:seq + 1]:
            if event["type"] == "edit":
                if "after_blob" not in event: raise WorkspaceError("HISTORY_UNAVAILABLE", "历史修改缺少固定快照")
                state[event["path"]] = event["after_blob"]
        for path, blob in state.items():
            ws.resolve(path, "write")
            if blob is not None: ws.checkpoints.get_blob(blob)
    id = uuid.uuid4().hex
    root = root_for(data_dir, id); root.parent.mkdir(parents=True, exist_ok=True)
    git(ws.primary, "worktree", "add", "--detach", str(root), base["commit"])
    record = {"id": id, "base_commit": base["commit"], "source_task": task_id, "source_seq": seq, "status": "open"}
    saved = engineering.get(ws, "sandboxes")
    engineering.put(ws, "sandboxes", [*(saved["value"] or []), record], saved["revision"], True)
    target, _ = open_workspace(ws, data_dir, id)
    if historical:
        for path, blob in state.items():
            revision = target.hash(path)["revision"]
            if blob is None:
                if revision != "absent": target.delete(path, Ctx("user"))
            else: target.write_bytes(path, ws.checkpoints.get_blob(blob), revision, Ctx("user"))
    return record


def snapshot(ws):
    tracked = git(ws.primary, "diff", "--name-only", "-z", "HEAD").split(b"\0")
    untracked = git(ws.primary, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    paths = sorted(set(p.decode("utf-8") for p in tracked + untracked if p))
    if len(paths) > 200: raise WorkspaceError("TOO_LARGE", "单次应用最多 200 个文件，请拆分任务")
    summary = git(ws.primary, "diff", "--summary", "HEAD").decode("utf-8", "replace")
    if "mode change" in summary:
        raise WorkspaceError("WORKSPACE_CAPABILITY", "执行权限变化需要手动审查")
    files = []
    for path in paths:
        target = ws.primary / path
        if any(p.is_symlink() for p in [target, *target.parents] if p != ws.primary and ws.primary in p.parents):
            raise WorkspaceError("WORKSPACE_CAPABILITY", "不能自动应用符号链接")
        verdict = ws.policy.check_path(target, "write")
        if verdict: raise WorkspaceError("POLICY_DENIED", verdict.reason)
        revision = ws.hash(path)["revision"]
        if revision == "absent": content = None
        else:
            read = ws.read(path)
            if read.get("binary"): raise WorkspaceError("WORKSPACE_CAPABILITY", "二进制变化请手动审查")
            content = read["content"]
        before = git(ws.primary, "show", "HEAD:" + path, missing=True)
        if before is None and target.is_file() and target.stat().st_mode & 0o111:
            raise WorkspaceError("WORKSPACE_CAPABILITY", "新增可执行文件需要手动审查")
        base_rev = "absent" if before is None else "sha256:" + hashlib.sha256(before).hexdigest()
        files.append({"path": path, "revision": revision, "base_revision": base_rev, "content": content, "before_content": None if before is None else before.decode("utf-8")})
    key = json.dumps([git(ws.primary, "rev-parse", "HEAD").decode().strip(), [[f["path"], f["revision"]] for f in files]], ensure_ascii=False, separators=(",", ":"))
    return {"files": files, "revision": hashlib.sha256(key.encode()).hexdigest()}


def inspect(ws, data_dir, id):
    child, record = open_workspace(ws, data_dir, id)
    if git(child.primary, "rev-parse", "HEAD").decode().strip() != record["base_commit"]:
        raise WorkspaceError("SANDBOX_BASE_CHANGED", "沙箱 Git HEAD 已改变，请保留原基准并重新审查")
    current = snapshot(child)
    tasks = [child.checkpoints.load(t["id"]) for t in child.checkpoints.list_tasks(50)]
    validations = [e for t in tasks for e in t["events"] if e["type"] == "build_ok" and e.get("workspace_revision") == current["revision"]]
    return {**record, **current, "tasks": tasks, "validated": bool(validations)}


def apply(ws, data_dir, id, revision):
    current = inspect(ws, data_dir, id)
    if current["status"] != "open": raise WorkspaceError("BAD_SANDBOX", "沙箱已经应用")
    if current["revision"] != revision: raise WorkspaceError("CONFLICT", "沙箱内容已变化，请重新审查")
    if not current["validated"]: raise WorkspaceError("VALIDATION_REQUIRED", "当前沙箱版本还没有真实通过的验证")
    conflicts = [f["path"] for f in current["files"] if ws.hash(f["path"])["revision"] != f["base_revision"]]
    if conflicts: raise WorkspaceError("CONFLICT", "主工作区与沙箱存在冲突", paths=conflicts)
    for f in current["files"]:
        ws.resolve(f["path"], "write")
    task = ws.checkpoints.start_task("应用沙箱 " + id, "edit")
    ctx = Ctx("user", task["id"])
    applied = []
    try:
        for f in current["files"]:
            if ws.hash(f["path"])["revision"] != f["base_revision"]: raise WorkspaceError("CONFLICT", "应用期间文件已变化")
            if f["content"] is None: ws.delete(f["path"], ctx)
            else: ws.write(f["path"], f["content"], f["base_revision"], ctx)
            applied.append(f["path"])
        ws.checkpoints.finish_task(task["id"], "done", "应用完成")
    except Exception:
        ws.checkpoints.finish_task(task["id"], "error", "部分应用，可从检查点恢复")
        raise
    saved = engineering.get(ws, "sandboxes")
    records = saved["value"]
    for r in records:
        if r["id"] == id: r["status"] = "applied"
    engineering.put(ws, "sandboxes", records, saved["revision"], True)
    return {"task_id": task["id"], "applied": applied}


def fingerprint(ws):
    try: return snapshot(ws)["revision"]
    except (WorkspaceError, OSError, ValueError): return None
