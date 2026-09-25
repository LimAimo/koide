"""Workspace: the only door through which users and agents touch project files.

Guarantees
  * every path is resolved (symlinks included) and must stay inside a workspace root
  * mutations are atomic (temp file + os.replace) and carry base-revision conflict detection
  * every mutation made inside an agent task is checkpointed first, so it can be reverted
  * deletes go to Diffusion Trash, never straight to oblivion
"""
from __future__ import annotations

import base64
import fnmatch
import hashlib
import os
import re
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..checkpoint.store import CheckpointStore, revision_of, sha256_hex
from ..security.policy import HardPolicy
from .trash import Trash

MAX_EVENT_TEXT = 512 * 1024          # larger texts are not shipped inside change events
MAX_READ_BYTES = 8 * 1024 * 1024
TMP_PREFIX = ".diffusion-tmp-"
HIDDEN_IN_TREE = {".git", ".DS_Store"}
SKIP_IN_SEARCH = {".git", "node_modules", "__pycache__", ".venv", "venv", ".gradle", ".idea"}


class WorkspaceError(Exception):
    def __init__(self, code: str, message: str, **data):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


@dataclass
class Ctx:
    """Who is acting. Agent tasks carry a task_id so their edits are checkpointed."""
    actor: str = "user"            # user | agent | system
    task_id: str | None = None


@dataclass
class Change:
    kind: str                       # create | modify | delete | rename
    path: str
    before_text: str | None
    after_text: str | None
    before_rev: str
    after_rev: str
    actor: str
    task_id: str | None = None
    old_path: str | None = None

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _decode(data: bytes | None) -> str | None:
    if data is None or len(data) > MAX_EVENT_TEXT or b"\0" in data[:4096]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


# ---------------------------------------------------------------------------------------------
# Patch engine
# ---------------------------------------------------------------------------------------------
def apply_edits(text: str, edits: list[dict]) -> str:
    """Apply a batch of edits atomically. Edits address the ORIGINAL text, so order does not matter.

    Edit forms:
      {"range": {"start": {"line": 1, "column": 1}, "end": {"line": 1, "column": 4}}, "new_text": "..."}
          line/column are 1-based, `end` is exclusive, columns count Unicode code points.
      {"old_text": "...", "new_text": "...", "replace_all": false}
          old_text must match exactly once unless replace_all is true.
    """
    crlf = "\r\n" in text
    norm = text.replace("\r\n", "\n")
    starts = [0]
    for m in re.finditer("\n", norm):
        starts.append(m.end())
    n_lines = len(starts)

    def offset(pos: dict) -> int:
        line, col = pos.get("line"), pos.get("column")
        if not isinstance(line, int) or not isinstance(col, int) or line < 1 or line > n_lines or col < 1:
            raise WorkspaceError("BAD_RANGE", f"位置超出范围：{pos}")
        line_end = (starts[line] - 1) if line < n_lines else len(norm)
        off = starts[line - 1] + col - 1
        if off > line_end:
            raise WorkspaceError("BAD_RANGE", f"列号超出第 {line} 行的末尾：{pos}")
        return off

    spans: list[tuple[int, int, str]] = []
    for i, e in enumerate(edits):
        new = str(e.get("new_text", "")).replace("\r\n", "\n")
        if "range" in e:
            s, t = offset(e["range"]["start"]), offset(e["range"]["end"])
            if t < s:
                raise WorkspaceError("BAD_RANGE", f"第 {i} 处修改：结束位置在起始位置之前")
            spans.append((s, t, new))
        elif "old_text" in e:
            old = str(e["old_text"]).replace("\r\n", "\n")
            if not old:
                raise WorkspaceError("BAD_EDIT", f"第 {i} 处修改：old_text 不能为空")
            hits = [m.start() for m in re.finditer(re.escape(old), norm)]
            if not hits:
                raise WorkspaceError("NO_MATCH", f"第 {i} 处修改：找不到 old_text，请重新读取文件", index=i)
            if len(hits) > 1 and not e.get("replace_all"):
                raise WorkspaceError("AMBIGUOUS_MATCH",
                                     f"第 {i} 处修改：old_text 匹配到 {len(hits)} 处，请增加上下文或设置 replace_all",
                                     index=i, count=len(hits))
            for h in (hits if e.get("replace_all") else hits[:1]):
                spans.append((h, h + len(old), new))
        else:
            raise WorkspaceError("BAD_EDIT", f"第 {i} 处修改：需要提供 range 或 old_text")
    spans.sort(key=lambda x: (x[0], x[1]))
    for a, b in zip(spans, spans[1:]):
        if b[0] < a[1]:
            raise WorkspaceError("OVERLAPPING_EDITS", "多处修改互相重叠")
    out, cursor = [], 0
    for s, t, new in spans:
        out.append(norm[cursor:s])
        out.append(new)
        cursor = t
    out.append(norm[cursor:])
    result = "".join(out)
    return result.replace("\n", "\r\n") if crlf else result


# ---------------------------------------------------------------------------------------------
class Workspace:
    def __init__(self, roots: list[Path], checkpoints: CheckpointStore, trash: Trash, policy: HardPolicy):
        if not roots:
            raise WorkspaceError("NO_ROOT", "工作区至少需要一个文件夹")
        self.roots = [Path(r).resolve() for r in roots]
        for r in self.roots:
            if not r.is_dir():
                raise WorkspaceError("NOT_A_FOLDER", f"{r} 不是文件夹")
        self.primary = self.roots[0]
        self.checkpoints, self.trash, self.policy = checkpoints, trash, policy
        self.listeners: list[Callable[[Change], None]] = []
        self._writes: dict[str, dict] = {}
        self._lock = threading.RLock()

    # ---- paths -------------------------------------------------------------------------------
    def info(self) -> dict:
        return {"roots": [str(r) for r in self.roots], "name": self.primary.name}

    def display(self, abs_path: Path) -> str:
        try:
            return abs_path.relative_to(self.primary).as_posix() or "."
        except ValueError:
            return str(abs_path)

    def resolve(self, path: str, op: str = "read", check_policy: bool = True) -> Path:
        if not isinstance(path, str) or not path or "\0" in path:
            raise WorkspaceError("BAD_PATH", "路径不能为空")
        raw = Path(path).expanduser()
        cand = raw if raw.is_absolute() else self.primary / raw
        real = cand.resolve()   # follows symlinks: a link that escapes the root is caught below
        if not any(real == r or r in real.parents for r in self.roots):
            raise WorkspaceError("OUTSIDE_WORKSPACE", f"{path} 在工作区之外", path=str(real))
        if check_policy:
            v = self.policy.check_path(real, op)
            if v and v.action == "deny":
                raise WorkspaceError("POLICY_DENIED", v.reason, path=str(real))
        return real

    def _emit(self, change: Change) -> None:
        for fn in list(self.listeners):
            try:
                fn(change)
            except Exception:
                pass

    # ---- reading -----------------------------------------------------------------------------
    def read(self, path: str) -> dict:
        p = self.resolve(path)
        if not p.is_file():
            raise WorkspaceError("NOT_FOUND", f"{path} 不是文件")
        size = p.stat().st_size
        if size > MAX_READ_BYTES:
            raise WorkspaceError("TOO_LARGE", f"{path} 有 {size} 字节，超过读取上限（{MAX_READ_BYTES}）")
        data = p.read_bytes()
        rev = revision_of(data)
        if b"\0" in data[:4096]:
            return {"path": self.display(p), "binary": True, "size": size, "revision": rev}
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return {"path": self.display(p), "binary": True, "size": size, "revision": rev}
        return {"path": self.display(p), "content": text, "revision": rev, "size": size, "binary": False}

    def hash(self, path: str) -> dict:
        p = self.resolve(path)
        return {"path": self.display(p), "revision": revision_of(p.read_bytes() if p.is_file() else None)}

    def tree(self, path: str = ".", depth: int = 1, show_hidden: bool = False) -> list[dict]:
        p = self.resolve(path) if path not in (".", "") else self.primary
        if not p.is_dir():
            raise WorkspaceError("NOT_A_FOLDER", f"{path} 不是文件夹")

        def walk(d: Path, level: int) -> list[dict]:
            entries = []
            try:
                children = sorted(d.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))
            except OSError:
                return []
            for c in children:
                if c.name.startswith(TMP_PREFIX) or (not show_hidden and c.name in HIDDEN_IN_TREE):
                    continue
                try:
                    st = c.stat()
                except OSError:
                    continue
                node = {"name": c.name, "path": self.display(c), "type": "dir" if c.is_dir() else "file",
                        "size": st.st_size, "mtime": st.st_mtime}
                if node["type"] == "dir" and level > 1:
                    node["children"] = walk(c, level - 1)
                entries.append(node)
            return entries

        return walk(p, max(1, depth))

    def glob(self, pattern: str, max_results: int = 200) -> dict:
        """Find files/folders by name pattern (e.g. `**/*.test.js`), without reading their content."""
        if not pattern:
            raise WorkspaceError("BAD_QUERY", "匹配模式不能为空")
        hits, truncated = [], False
        for root in self.roots:
            for dirpath, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in SKIP_IN_SEARCH]
                names = [(d + "/") for d in dirs] + files
                for fn in names:
                    if fn.startswith(TMP_PREFIX):
                        continue
                    fp = Path(dirpath) / fn.rstrip("/")
                    rel = self.display(fp) + ("/" if fn.endswith("/") else "")
                    if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(fn.rstrip("/"), pattern) or fnmatch.fnmatch(rel.lstrip("./"), pattern):
                        hits.append(rel)
                        if len(hits) >= max_results:
                            truncated = True
                            return {"entries": sorted(dict.fromkeys(hits)), "truncated": truncated}
        return {"entries": sorted(dict.fromkeys(hits)), "truncated": truncated}

    def search(self, query: str, regex: bool = False, glob: str | None = None,
               case_sensitive: bool = False, max_results: int = 200) -> dict:
        if not query:
            raise WorkspaceError("BAD_QUERY", "搜索内容不能为空")
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            pat = re.compile(query if regex else re.escape(query), flags)
        except re.error as e:
            raise WorkspaceError("BAD_QUERY", f"正则表达式无效：{e}")
        hits, files_scanned, truncated = [], 0, False
        for root in self.roots:
            for dirpath, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in SKIP_IN_SEARCH]
                for fn in files:
                    if fn.startswith(TMP_PREFIX):
                        continue
                    fp = Path(dirpath) / fn
                    rel = self.display(fp)
                    if glob and not (fnmatch.fnmatch(rel, glob) or fnmatch.fnmatch(fn, glob)):
                        continue
                    try:
                        if fp.stat().st_size > 1_000_000:
                            continue
                        data = fp.read_bytes()
                    except OSError:
                        continue
                    if b"\0" in data[:4096]:
                        continue
                    files_scanned += 1
                    for ln, line in enumerate(data.decode("utf-8", "replace").split("\n"), 1):
                        m = pat.search(line)
                        if m:
                            hits.append({"path": rel, "line": ln, "column": m.start() + 1, "text": line[:300]})
                            if len(hits) >= max_results:
                                return {"matches": hits, "files_scanned": files_scanned, "truncated": True}
        return {"matches": hits, "files_scanned": files_scanned, "truncated": truncated}

    # ---- low-level mutation core ---------------------------------------------------------------
    def _atomic_write(self, target: Path, data: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.parent / f"{TMP_PREFIX}{uuid.uuid4().hex[:8]}"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            if target.exists():
                shutil.copymode(target, tmp)
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)

    def _check_base(self, current: bytes | None, base_revision: str | None, path: str) -> None:
        if base_revision is None:
            return
        cur = revision_of(current)
        if cur != base_revision:
            raise WorkspaceError("CONFLICT",
                                 f"{path} 在读取之后已被修改（预期版本 {base_revision[:15]}，当前 {cur[:15]}）。"
                                 "请重新读取该文件后再试。", current_revision=cur)

    def _snapshot(self, abs_path: Path, ctx: Ctx, before: bytes | None) -> None:
        if ctx.task_id:
            self.checkpoints.record_before(ctx.task_id, self.display(abs_path), before)

    def _log_edit(self, ctx: Ctx, kind: str, rel: str, before: bytes | None, after: bytes | None, **extra) -> None:
        if ctx.task_id:
            verb = {"create": "新建", "modify": "修改", "delete": "删除", "rename": "重命名"}[kind]
            self.checkpoints.add_event(
                ctx.task_id, "edit", f"{verb} {rel}", path=rel, kind=kind,
                before_blob=self.checkpoints.blob_for_event_before(before),
                existed_before=before is not None, after_rev=revision_of(after), **extra)

    def _commit_bytes(self, p: Path, data: bytes, ctx: Ctx, base_revision: str | None) -> dict:
        with self._lock:
            before = p.read_bytes() if p.is_file() else None
            if p.exists() and not p.is_file():
                raise WorkspaceError("NOT_A_FILE", f"{self.display(p)} 不是文件")
            self._check_base(before, base_revision, self.display(p))
            if before == data:
                return {"path": self.display(p), "revision": revision_of(data), "changed": False}
            self._snapshot(p, ctx, before)
            self._atomic_write(p, data)
            rel = self.display(p)
            kind = "create" if before is None else "modify"
            self._log_edit(ctx, kind, rel, before, data)
            self._emit(Change(kind, rel, _decode(before), _decode(data), revision_of(before),
                              revision_of(data), ctx.actor, ctx.task_id))
            return {"path": rel, "revision": revision_of(data), "changed": True}

    # ---- public mutations ----------------------------------------------------------------------
    def write(self, path: str, content: str, base_revision: str | None = None, ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        return self._commit_bytes(self.resolve(path, "write"), content.encode("utf-8"), ctx, base_revision)

    def write_bytes(self, path: str, data: bytes, base_revision: str | None = None, ctx: Ctx | None = None) -> dict:
        """Binary-safe mutation entrypoint used by system operations such as protected Git restore."""
        ctx = ctx or Ctx()
        return self._commit_bytes(self.resolve(path, "write"), data, ctx, base_revision)

    def set_executable(self, path: str, executable: bool) -> None:
        p = self.resolve(path, "write")
        if not p.is_file():
            return
        mode = p.stat().st_mode
        if executable:
            p.chmod(mode | 0o111)
        else:
            p.chmod(mode & ~0o111)

    def patch(self, path: str, base_revision: str, edits: list[dict], ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        if not base_revision:
            raise WorkspaceError("NEEDS_REVISION", "修改文件需要 base_revision，请先读取该文件")
        if not isinstance(edits, list) or not edits:
            raise WorkspaceError("BAD_EDIT", "edits 必须是非空列表")
        p = self.resolve(path, "patch")
        with self._lock:
            if not p.is_file():
                raise WorkspaceError("NOT_FOUND", f"{path} 不存在")
            raw = p.read_bytes()
            self._check_base(raw, base_revision, self.display(p))
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                raise WorkspaceError("BINARY", f"{path} 不是 UTF-8 文本")
            new_text = apply_edits(text, edits)
            return self._commit_bytes(p, new_text.encode("utf-8"), ctx, base_revision)

    def create(self, path: str, kind: str = "file", content: str = "", ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        p = self.resolve(path, "create")
        if p.exists():
            raise WorkspaceError("EXISTS", f"{path} 已存在")
        if kind == "dir":
            p.mkdir(parents=True)
            return {"path": self.display(p), "type": "dir"}
        return self._commit_bytes(p, content.encode("utf-8"), ctx, "absent")

    def _record_tree(self, root: Path, ctx: Ctx, existed: bool, limit: int = 2000) -> None:
        if not ctx.task_id:
            return
        n = 0
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                fp = Path(dirpath) / fn
                self._snapshot(fp, ctx, fp.read_bytes() if existed else None)
                n += 1
                if n >= limit:
                    return

    def delete(self, path: str, ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        p = self.resolve(path, "delete")
        if any(p == r for r in self.roots):
            raise WorkspaceError("POLICY_DENIED", "不能删除工作区根目录")
        if not p.exists():
            raise WorkspaceError("NOT_FOUND", f"{path} 不存在")
        with self._lock:
            rel = self.display(p)
            if p.is_file():
                before = p.read_bytes()
                self._snapshot(p, ctx, before)
            else:
                before = None
                self._record_tree(p, ctx, existed=True)
            trash_id = self.trash.move_in(p)
            self._log_edit(ctx, "delete", rel, before, None, trash_id=trash_id)
            self._emit(Change("delete", rel, _decode(before), None, revision_of(before), "absent",
                              ctx.actor, ctx.task_id))
            return {"path": rel, "trash_id": trash_id}

    def rename(self, src: str, dst: str, ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        s, d = self.resolve(src, "rename"), self.resolve(dst, "rename")
        if not s.exists():
            raise WorkspaceError("NOT_FOUND", f"{src} 不存在")
        if d.exists():
            raise WorkspaceError("EXISTS", f"{dst} 已存在")
        with self._lock:
            if s.is_file():
                self._snapshot(s, ctx, s.read_bytes())
            else:
                self._record_tree(s, ctx, existed=True)
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(s), str(d))
            if d.is_file():
                self._snapshot(d, ctx, None)
            else:
                self._record_tree(d, ctx, existed=False)
            self._log_edit(ctx, "rename", self.display(d), None, d.read_bytes() if d.is_file() else None,
                           old_path=self.display(s))
            self._emit(Change("rename", self.display(d), None, None, "", "", ctx.actor, ctx.task_id,
                              old_path=self.display(s)))
            return {"path": self.display(d), "old_path": self.display(s)}

    def copy(self, src: str, dst: str, ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        s, d = self.resolve(src, "read"), self.resolve(dst, "create")
        if not s.exists():
            raise WorkspaceError("NOT_FOUND", f"{src} 不存在")
        if d.exists():
            raise WorkspaceError("EXISTS", f"{dst} 已存在")
        if s.is_file():
            return self._commit_bytes(d, s.read_bytes(), ctx, "absent")
        shutil.copytree(s, d)
        self._record_tree(d, ctx, existed=False)
        return {"path": self.display(d), "type": "dir"}

    # ---- transactional (large) writes -----------------------------------------------------------
    def begin_write(self, path: str, base_revision: str | None = None, ctx: Ctx | None = None) -> dict:
        ctx = ctx or Ctx()
        p = self.resolve(path, "write")
        with self._lock:
            self._check_base(p.read_bytes() if p.is_file() else None, base_revision, self.display(p))
        wid = uuid.uuid4().hex[:12]
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.parent / f"{TMP_PREFIX}{wid}"
        tmp.write_bytes(b"")
        self._writes[wid] = {"target": p, "tmp": tmp, "next_seq": 0, "bytes": 0, "sha": hashlib.sha256(),
                             "base": base_revision, "ctx": ctx}
        return {"write_id": wid}

    def _get_write(self, wid: str) -> dict:
        w = self._writes.get(wid)
        if not w:
            raise WorkspaceError("NO_SUCH_WRITE", "写入事务不存在或已结束")
        return w

    def write_chunk(self, write_id: str, seq: int, data: str, encoding: str = "utf-8") -> dict:
        w = self._get_write(write_id)
        if seq != w["next_seq"]:
            self.abort_write(write_id)
            raise WorkspaceError("SEQUENCE_ERROR", f"期望第 {w['next_seq']} 块，收到第 {seq} 块；写入已中止")
        raw = base64.b64decode(data) if encoding == "base64" else data.encode("utf-8")
        with open(w["tmp"], "ab") as f:
            f.write(raw)
        w["sha"].update(raw)
        w["bytes"] += len(raw)
        w["next_seq"] += 1
        return {"received_bytes": w["bytes"], "next_seq": w["next_seq"]}

    def commit_write(self, write_id: str, total_bytes: int, sha256: str) -> dict:
        w = self._get_write(write_id)
        try:
            if w["bytes"] != total_bytes:
                raise WorkspaceError("BYTE_COUNT_MISMATCH", f"收到 {w['bytes']} 字节，期望 {total_bytes} 字节")
            if w["sha"].hexdigest() != sha256.removeprefix("sha256:"):
                raise WorkspaceError("HASH_MISMATCH", "内容哈希不匹配；原文件未被改动")
            data = w["tmp"].read_bytes()
            return self._commit_bytes(w["target"], data, w["ctx"], w["base"])
        finally:
            self.abort_write(write_id)

    def abort_write(self, write_id: str) -> dict:
        w = self._writes.pop(write_id, None)
        if w:
            w["tmp"].unlink(missing_ok=True)
        return {"aborted": bool(w)}

    # ---- restore (Time Machine) -----------------------------------------------------------------
    def _restore_state(self, rel: str, existed: bool, blob: str | None, ctx: Ctx) -> None:
        p = self.resolve(rel, "write")
        with self._lock:
            current = p.read_bytes() if p.is_file() else None
            if existed:
                data = self.checkpoints.get_blob(blob)
                if current == data:
                    return
                self._atomic_write(p, data)
                kind = "create" if current is None else "modify"
                self._emit(Change(kind, rel, _decode(current), _decode(data), revision_of(current),
                                  revision_of(data), ctx.actor, None))
            elif current is not None:
                self.trash.move_in(p)
                self._emit(Change("delete", rel, _decode(current), None, revision_of(current), "absent",
                                  ctx.actor, None))

    def revert_file(self, task_id: str, rel: str) -> dict:
        m = self.checkpoints.load(task_id)
        snap = m["files"].get(rel)
        if not snap:
            raise WorkspaceError("NOT_IN_TASK", f"任务 {task_id} 没有改动过 {rel}")
        self._restore_state(rel, snap["existed"], snap["blob"], Ctx("system"))
        return {"reverted": [rel]}

    def revert_task(self, task_id: str) -> dict:
        m = self.checkpoints.load(task_id)
        done = []
        for rel, snap in m["files"].items():
            self._restore_state(rel, snap["existed"], snap["blob"], Ctx("system"))
            done.append(rel)
        self.checkpoints.mark_reverted(task_id, [e["seq"] for e in m["events"] if e["type"] == "edit"])
        self.checkpoints.add_event(task_id, "revert", f"已将 {len(done)} 个文件恢复到任务开始之前")
        return {"reverted": done}

    def revert_event(self, task_id: str, seq: int, force: bool = False) -> dict:
        m = self.checkpoints.load(task_id)
        ev = m["events"][seq] if 0 <= seq < len(m["events"]) else None
        if not ev or ev["type"] != "edit" or ev.get("kind") not in ("create", "modify", "delete"):
            raise WorkspaceError("NOT_REVERTIBLE", "这条记录无法单独撤销")
        rel = ev["path"]
        p = self.resolve(rel, "write")
        current = p.read_bytes() if p.is_file() else None
        if not force and revision_of(current) != ev["after_rev"]:
            raise WorkspaceError("CONFLICT", f"{rel} 在这一步之后又被修改过，撤销会丢失后续的工作",
                                 current_revision=revision_of(current))
        self._restore_state(rel, ev["existed_before"], ev["before_blob"], Ctx("system"))
        self.checkpoints.mark_reverted(task_id, [seq])
        return {"reverted": [rel]}

    def event_diff(self, task_id: str, seq: int) -> dict:
        """Before/after text for a timeline entry so the UI can show the diff at that moment."""
        m = self.checkpoints.load(task_id)
        ev = m["events"][seq]
        if ev["type"] != "edit":
            raise WorkspaceError("NOT_AN_EDIT", "这条记录没有可比较的差异")
        before = self.checkpoints.get_blob(ev["before_blob"]) if ev.get("before_blob") else None
        nxt = None
        for later in m["events"][seq + 1:]:
            if later["type"] == "edit" and later.get("path") == ev["path"]:
                nxt = later
                break
        after = None
        if nxt is not None and nxt.get("before_blob"):
            after = self.checkpoints.get_blob(nxt["before_blob"])
        else:
            p = self.resolve(ev["path"])
            after = p.read_bytes() if p.is_file() else None
        return {"path": ev["path"], "before": _decode(before), "after": _decode(after)}

    # ---- trash passthrough -----------------------------------------------------------------------
    def restore_from_trash(self, trash_id: str) -> dict:
        dest = self.trash.restore(trash_id)
        data = dest.read_bytes() if dest.is_file() else None
        self._emit(Change("create", self.display(dest), None, _decode(data), "absent", revision_of(data), "system"))
        return {"path": self.display(dest)}
