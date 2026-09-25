"""Built-in tools. Each handler is `async def handler(tc: ToolContext, args: dict) -> dict`."""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from ..filesystem.workspace import Ctx, Workspace, WorkspaceError
from ..process.runner import run_shell
from .registry import Tool, ToolRegistry


@dataclass
class ToolContext:
    workspace: Workspace
    ctx: Ctx
    cancel: asyncio.Event
    emit: Callable[[str, dict], None]
    call_id: str = ""
    read_revisions: dict = field(default_factory=dict)   # path -> revision the agent last saw
    terminals: Any = None
    ask_user: Any = None


def _rel(tc: ToolContext, path: str) -> str:
    return tc.workspace.display(tc.workspace.resolve(path))


async def fs_read(tc: ToolContext, a: dict) -> dict:
    res = await asyncio.to_thread(tc.workspace.read, a["path"])
    if res.get("binary"):
        return {"path": res["path"], "binary": True, "size": res["size"]}
    tc.read_revisions[res["path"]] = res["revision"]
    lines = res["content"].split("\n")
    start, end = a.get("start_line"), a.get("end_line")
    if start or end:
        s, e = max(1, start or 1), min(len(lines), end or len(lines))
        body = "\n".join(f"{i}: {lines[i - 1]}" for i in range(s, e + 1))
        return {"path": res["path"], "revision": res["revision"], "total_lines": len(lines),
                "range": [s, e], "content": body}
    return {"path": res["path"], "revision": res["revision"], "total_lines": len(lines), "content": res["content"]}


async def fs_list(tc: ToolContext, a: dict) -> dict:
    tree = await asyncio.to_thread(tc.workspace.tree, a.get("path", "."), a.get("depth", 1))

    def flat(nodes, out):
        for n in nodes:
            out.append(n["path"] + ("/" if n["type"] == "dir" else ""))
            flat(n.get("children", []), out)
        return out
    return {"entries": flat(tree, [])}


async def fs_search(tc: ToolContext, a: dict) -> dict:
    return await asyncio.to_thread(tc.workspace.search, a["query"], bool(a.get("regex")), a.get("glob"),
                                   bool(a.get("case_sensitive")), a.get("max_results", 100))


async def fs_glob(tc: ToolContext, a: dict) -> dict:
    return await asyncio.to_thread(tc.workspace.glob, a["pattern"], a.get("max_results", 200))


async def fs_multi_read(tc: ToolContext, a: dict) -> dict:
    paths = a["paths"][:20]
    files = []
    for p in paths:
        try:
            res = await asyncio.to_thread(tc.workspace.read, p)
        except WorkspaceError as e:
            files.append({"path": p, "error": f"{e.code}: {e.message}"})
            continue
        if res.get("binary"):
            files.append({"path": res["path"], "binary": True, "size": res["size"]})
            continue
        tc.read_revisions[res["path"]] = res["revision"]
        files.append({"path": res["path"], "revision": res["revision"], "content": res["content"]})
    return {"files": files}


async def fs_patch(tc: ToolContext, a: dict) -> dict:
    rel = _rel(tc, a["path"])
    base = a.get("base_revision") or tc.read_revisions.get(rel)
    if not base:
        raise WorkspaceError("NEEDS_READ", f"修改 {rel} 之前请先用 fs_read 读取它")
    res = await asyncio.to_thread(tc.workspace.patch, a["path"], base, a["edits"], tc.ctx)
    tc.read_revisions[res["path"]] = res["revision"]
    return res


async def fs_write(tc: ToolContext, a: dict) -> dict:
    rel = _rel(tc, a["path"])
    exists = (tc.workspace.resolve(a["path"])).exists()
    base = a.get("base_revision") or tc.read_revisions.get(rel) or (None if exists else "absent")
    if exists and not base:
        raise WorkspaceError("NEEDS_READ", f"{rel} 已存在，请先读取它，或改用 fs_patch")
    res = await asyncio.to_thread(tc.workspace.write, a["path"], a["content"], base, tc.ctx)
    tc.read_revisions[res["path"]] = res["revision"]
    return res


async def fs_delete(tc: ToolContext, a: dict) -> dict:
    return await asyncio.to_thread(tc.workspace.delete, a["path"], tc.ctx)


async def fs_rename(tc: ToolContext, a: dict) -> dict:
    return await asyncio.to_thread(tc.workspace.rename, a["from"], a["to"], tc.ctx)


async def shell_run(tc: ToolContext, a: dict) -> dict:
    timeout = float(a.get("timeout_seconds", 120))

    def out(stream: str, text: str):
        tc.emit("terminal.output", {"source": "agent", "call_id": tc.call_id, "stream": stream, "data": text})

    tc.emit("terminal.start", {"source": "agent", "call_id": tc.call_id, "command": a["command"]})
    res = await run_shell(a["command"], str(tc.workspace.primary), timeout, tc.cancel, out)
    tc.emit("terminal.exit", {"source": "agent", "call_id": tc.call_id, "exit_code": res["exit_code"]})
    return res


_EDIT = {"type": "object", "properties": {
    "old_text": {"type": "string", "description": "Exact text to replace; must occur exactly once unless replace_all"},
    "new_text": {"type": "string"},
    "replace_all": {"type": "boolean"},
    "range": {"type": "object", "description": "1-based line/column, end exclusive",
              "properties": {"start": {"type": "object", "properties": {"line": {"type": "integer", "minimum": 1},
                                                                      "column": {"type": "integer", "minimum": 1}},
                                       "required": ["line", "column"]},
                             "end": {"type": "object", "properties": {"line": {"type": "integer", "minimum": 1},
                                                                    "column": {"type": "integer", "minimum": 1}},
                                     "required": ["line", "column"]}},
              "required": ["start", "end"]}},
    "required": ["new_text"]}


async def ask_user(tc: ToolContext, a: dict) -> dict:
    if tc.ask_user is None:
        raise WorkspaceError("NO_INTERACTION", "当前运行环境不能向用户提问")
    items = a.get("questions") or ([{"question": a["question"], "options": a.get("options"),
                                    "allow_custom": a.get("allow_custom")}] if a.get("question") else [])
    if not items:
        raise WorkspaceError("BAD_ARGUMENTS", "至少要有一个问题")
    normalized = [{"question": it["question"], "options": it.get("options") or [],
                  "allow_custom": bool(it.get("allow_custom", True))} for it in items]
    answers = await tc.ask_user({"questions": normalized})
    return {"answers": answers,
            "summary": [{"question": q["question"], "answer": a_} for q, a_ in zip(normalized, answers)]}


async def terminal_read(tc: ToolContext, a: dict) -> dict:
    mgr = tc.terminals
    sess = mgr.get(a.get("id")) if mgr else None
    if not sess:
        return {"output": "", "note": "没有打开的终端会话"}
    n = int(a.get("max_chars", 4000))
    return {"id": sess.sid, "alive": sess.alive, "output": sess.ring[-n:]}


_WEB_FETCH_MAX_BYTES = 800_000
_WEB_FETCH_MAX_CHARS = 20_000


def _blocked_host(host: str) -> bool:
    """Best-effort SSRF guard: refuse to fetch the bridge's own machine or link-local / private targets."""
    import ipaddress
    import socket
    h = host.lower().strip("[]")
    if h in ("localhost", "localhost.localdomain") or h.endswith(".local"):
        return True
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(h, None)}
    except OSError:
        return False  # can't resolve; let the request fail naturally rather than block on a false positive
    for addr in addrs:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return True
    return False


async def web_fetch(tc: ToolContext, a: dict) -> dict:
    import urllib.error
    import urllib.parse
    import urllib.request

    url = a["url"].strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise WorkspaceError("BAD_URL", "只支持 http/https 网址")
    if not parsed.hostname:
        raise WorkspaceError("BAD_URL", "网址缺少主机名")

    def do_fetch() -> dict:
        if _blocked_host(parsed.hostname):
            raise WorkspaceError("BLOCKED_HOST", "出于安全考虑，禁止访问本机或内网地址")
        req = urllib.request.Request(url, headers={"User-Agent": "Diffusion-IDE-Agent/1.0",
                                                    "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.5"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                status = resp.status
                ctype = resp.headers.get("Content-Type", "")
                data = resp.read(_WEB_FETCH_MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            return {"url": url, "status": e.code, "content_type": e.headers.get("Content-Type", "") if e.headers else "",
                    "content": (e.read() or b"").decode("utf-8", "replace")[:2000], "truncated": False}
        except urllib.error.URLError as e:
            raise WorkspaceError("FETCH_FAILED", f"请求失败：{e.reason}")
        truncated = len(data) > _WEB_FETCH_MAX_BYTES
        text = data[:_WEB_FETCH_MAX_BYTES].decode("utf-8", "replace")
        if "text" in ctype or "json" in ctype or "xml" in ctype or not ctype:
            if "html" in ctype:
                text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
                text = re.sub(r"(?s)<[^>]+>", " ", text)
                text = re.sub(r"[ \t]+", " ", text)
                text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
        else:
            text = f"[非文本内容，Content-Type: {ctype}]"
        if len(text) > _WEB_FETCH_MAX_CHARS:
            text, truncated = text[:_WEB_FETCH_MAX_CHARS], True
        return {"url": url, "status": status, "content_type": ctype, "content": text, "truncated": truncated}

    return await asyncio.to_thread(do_fetch)


def build_registry() -> ToolRegistry:
    r = ToolRegistry()
    r.register(Tool("fs_read", "Read a text file. Returns its content and a revision hash used by later edits. "
                                "Usage: {\"path\": \"src/app.py\"}. Always read a file before you fs_patch or "
                                "fs_write it — you need its current content and revision.",
                    {"type": "object", "properties": {"path": {"type": "string"},
                                                      "start_line": {"type": "integer", "minimum": 1},
                                                      "end_line": {"type": "integer", "minimum": 1}},
                     "required": ["path"], "additionalProperties": False},
                    "read", "low", fs_read, activity="reading", title=lambda a: f'读取“{a.get("path", "")}”',
                    display_name="读取文件"))
    r.register(Tool("fs_list", "List files and folders in a directory (depth 1-4). Usage: {\"path\": \".\"} for the "
                               "workspace root, or {\"path\": \"src\", \"depth\": 2}.",
                    {"type": "object", "properties": {"path": {"type": "string"},
                                                      "depth": {"type": "integer", "minimum": 1, "maximum": 4}},
                     "additionalProperties": False},
                    "read", "low", fs_list, activity="searching", title=lambda a: f'列出“{a.get("path", ".")}”',
                    display_name="浏览文件"))
    r.register(Tool("fs_search", "Search text (or regex) across the workspace. Usage: {\"query\": \"TODO\"} or "
                                 "{\"query\": \"class \\\\w+Error\", \"regex\": true, \"glob\": \"*.py\"}. Use this "
                                 "to find WHERE something is, not fs_glob (that only matches file names/paths).",
                    {"type": "object", "properties": {"query": {"type": "string", "minLength": 1},
                                                      "regex": {"type": "boolean"}, "glob": {"type": "string"},
                                                      "case_sensitive": {"type": "boolean"},
                                                      "max_results": {"type": "integer", "minimum": 1, "maximum": 500}},
                     "required": ["query"], "additionalProperties": False},
                    "read", "low", fs_search, activity="searching", title=lambda a: f'搜索“{a.get("query", "")}”',
                    display_name="搜索工作区"))
    r.register(Tool("fs_glob", "Find files/folders by name pattern (e.g. `**/*.test.js`, `src/**/*.py`), "
                               "without reading or scanning file content. Faster than fs_search when you only need "
                               "paths. Usage: {\"pattern\": \"**/*.test.ts\"}.",
                    {"type": "object", "properties": {"pattern": {"type": "string", "minLength": 1},
                                                      "max_results": {"type": "integer", "minimum": 1, "maximum": 1000}},
                     "required": ["pattern"], "additionalProperties": False},
                    "read", "low", fs_glob, activity="searching", title=lambda a: f'查找“{a.get("pattern", "")}”',
                    display_name="按名称查找文件"))
    r.register(Tool("fs_multi_read", "Read several text files in one call (up to 20). Prefer this over several "
                                     "separate fs_read calls when you already know which files you need. Usage: "
                                     "{\"paths\": [\"src/a.py\", \"src/b.py\"]}.",
                    {"type": "object", "properties": {"paths": {"type": "array", "minItems": 1, "maxItems": 20,
                                                                "items": {"type": "string"}}},
                     "required": ["paths"], "additionalProperties": False},
                    "read", "low", fs_multi_read, activity="reading",
                    title=lambda a: f'批量读取 {len(a.get("paths", []))} 个文件',
                    display_name="批量读取文件"))
    r.register(Tool("fs_patch", "Edit an existing file with small exact edits. Preferred over rewriting whole files. "
                                "Read the file first — you need its exact current text and revision. Usage: "
                                "{\"path\": \"src/app.py\", \"edits\": [{\"old_text\": \"def foo():\\n    pass\", "
                                "\"new_text\": \"def foo():\\n    return 1\"}]}. IMPORTANT: old_text must match the "
                                "file's current content byte-for-byte (same whitespace/indentation/line breaks) and "
                                "occur exactly once, unless you set replace_all. Copy old_text from the fs_read "
                                "result instead of retyping it from memory. If a patch is rejected as CONFLICT or "
                                "NO_MATCH, fs_read the file again — its content is not what you think it is — and "
                                "retry with the corrected old_text; do not keep resending the same failing edit.",
                    {"type": "object", "properties": {"path": {"type": "string"},
                                                      "base_revision": {"type": "string"},
                                                      "edits": {"type": "array", "minItems": 1, "items": _EDIT}},
                     "required": ["path", "edits"], "additionalProperties": False},
                    "write", "medium", fs_patch, activity="editing", title=lambda a: f'修改“{a.get("path", "")}”',
                    display_name="修改文件"))
    r.register(Tool("fs_write", "Create a new file, or fully replace one you have already read. Usage: "
                                "{\"path\": \"src/new.py\", \"content\": \"...\"}. For an EXISTING file, prefer "
                                "fs_patch for small edits — fs_write overwrites the whole file, so you must supply "
                                "its complete new content, not just the changed lines.",
                    {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"},
                                                      "base_revision": {"type": "string"}},
                     "required": ["path", "content"], "additionalProperties": False},
                    "write", "medium", fs_write, activity="editing", title=lambda a: f'写入“{a.get("path", "")}”',
                    display_name="写入文件"))
    r.register(Tool("fs_delete", "Delete a file or folder (moved to Diffusion Trash, recoverable). "
                                 "Usage: {\"path\": \"old/file.py\"}.",
                    {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"],
                     "additionalProperties": False},
                    "delete", "medium", fs_delete, activity="editing", title=lambda a: f'删除“{a.get("path", "")}”',
                    display_name="删除文件"))
    r.register(Tool("fs_rename", "Rename or move a file or folder. Usage: {\"from\": \"old/path.py\", \"to\": "
                                 "\"new/path.py\"}.",
                    {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}},
                     "required": ["from", "to"], "additionalProperties": False},
                    "write", "medium", fs_rename, activity="editing",
                    title=lambda a: f'重命名“{a.get("from", "")}”', display_name="重命名 / 移动文件"))
    r.register(Tool("ask_user", "Ask the user one or more concise questions at once when their choice or missing "

                               "information is required — e.g. picking a library, confirming a destructive rename, "
                               "or several related preferences together. Prefer bundling related questions into one "
                               "call over calling this repeatedly; the user answers them all at once. Use native "
                               "`options` when practical. Do not guess an answer instead of asking.",
                    {"type": "object", "properties": {
                        "questions": {"type": "array", "minItems": 1, "maxItems": 6, "items": {
                            "type": "object", "properties": {
                                "question": {"type": "string", "minLength": 1},
                                "options": {"type": "array", "items": {"type": "string"}},
                                "allow_custom": {"type": "boolean"}},
                            "required": ["question"], "additionalProperties": False}},
                        # Back-compat shorthand for a single question; prefer `questions`.
                        "question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}},
                        "allow_custom": {"type": "boolean"}},
                     "additionalProperties": False},
                    "interaction", "low", ask_user, activity="waiting_user", timeout=0,
                    title=lambda a: (f'{len(a["questions"])} 个问题' if a.get("questions") and len(a["questions"]) > 1
                                      else f'询问：{(a.get("questions", [{}])[0].get("question", "") if a.get("questions") else a.get("question", ""))[:48]}'),
                    display_name="向你提问"))
    r.register(Tool("terminal_read", "Read the recent output of the user's open terminal (keystrokes are never recorded).",
                    {"type": "object", "properties": {"id": {"type": "string"}, "max_chars": {"type": "integer", "minimum": 100, "maximum": 20000}},
                     "additionalProperties": False},
                    "exec", "low", terminal_read, activity="reading", title=lambda a: "读取终端输出",
                    display_name="读取终端"))
    r.register(Tool("shell_run", "Run a shell command in the workspace root (build, test, git, etc.). Usage: "
                                 "{\"command\": \"npm test\"}. One command per call — use && to chain steps that "
                                 "must run together. This is the ONLY way to actually run something; describing a "
                                 "command in your reply does not execute it.",
                    {"type": "object", "properties": {"command": {"type": "string", "minLength": 1},
                                                      "timeout_seconds": {"type": "integer", "minimum": 1,
                                                                          "maximum": 1800}},
                     "required": ["command"], "additionalProperties": False},
                    "exec", "medium", shell_run, activity="running", cancelable=True, timeout=1830,
                    title=lambda a: f'运行“{a.get("command", "")[:80]}”', display_name="运行命令"))
    r.register(Tool("web_fetch", "Fetch a URL (http/https) and return its readable text content (HTML tags are "
                               "stripped). Useful for reading documentation or a package's README before using it. "
                               "Usage: {\"url\": \"https://example.com/docs\"}. "
                               "Cannot access the bridge machine's own network (localhost/private addresses).",
                    {"type": "object", "properties": {"url": {"type": "string", "minLength": 1}},
                     "required": ["url"], "additionalProperties": False},
                    "network", "medium", web_fetch, activity="reading", timeout=25,
                    title=lambda a: f'获取“{a.get("url", "")}”', display_name="访问网页"))
    return r
