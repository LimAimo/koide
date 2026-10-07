"""BridgeApp: shared state (workspace, permissions, agent) and the RPC surface used over WebSocket.

Wire format
  client -> bridge : {"type":"rpc","id":N,"method":"fs.read","params":{...}}
  bridge -> client : {"type":"result","id":N,"result":...} | {"type":"error","id":N,"error":{code,message,data}}
  bridge -> client : {"type":"event","event":"fs.changed","data":{...}}
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import re
import secrets
import sys
import time
import traceback
import uuid
from pathlib import Path

from .agent.conversations import ConversationStore
from .agent.constitution import AIMO_CONSTITUTION
from .agent.runtime import AgentRun, MODE_CLASSES
from .git import ops as gitops
from .protocol.net import lan_addresses
from .terminal.manager import TerminalManager
from .terminal.pty_session import PtyUnavailable, listening_ports
from .checkpoint.store import CheckpointStore
from .filesystem import watcher
from .filesystem.trash import Trash, TrashError
from .filesystem.workspace import Change, Ctx, Workspace, WorkspaceError
from .process.runner import run_shell
from .providers.openai_compat import NOT_YET, PRESETS, ProviderError, get_provider
from .providers.profiles import ProfileStore
from .security.devices import DeviceStore
from .security.permissions import MODES, TOOL_SETTINGS, PermissionEngine
from .security.policy import HardPolicy
from .tools.builtin import build_registry
from .studio import Studio
from .preview import PreviewManager

VERSION = "0.11.0"


class Connection:
    """One WebSocket client. Outbound messages go through a queue so senders never block each other."""

    def __init__(self, ws, peer: str, device: dict | None = None):
        self.ws, self.peer, self.device = ws, peer, device
        self.queue: asyncio.Queue = asyncio.Queue()
        self.task = asyncio.ensure_future(self._pump())

    def send(self, obj: dict) -> None:
        self.queue.put_nowait(json.dumps(obj, default=str, ensure_ascii=False))

    async def _pump(self) -> None:
        from .protocol.ws import OP_PING, WebSocketClosed
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(self.queue.get(), 30)
                except asyncio.TimeoutError:
                    await self.ws._send_frame(OP_PING, b"")     # keep phones' sockets alive
                    continue
                if msg is None:
                    return
                await self.ws.send_text(msg)
        except (WebSocketClosed, ConnectionError, OSError):
            return

    def close(self) -> None:
        self.queue.put_nowait(None)


class BridgeApp:
    def __init__(self, data_dir: Path, web_dir: Path, bridge_dir: Path, lan: bool = False,
                 allow_self_modify: bool = False, port: int = 8765):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.web_dir, self.bridge_dir, self.lan, self.port = Path(web_dir), Path(bridge_dir), lan, port
        self.packs_dir = self.bridge_dir.parent / "animation-packs"
        self.loop: asyncio.AbstractEventLoop | None = None
        self.policy = HardPolicy(bridge_dir, self.data_dir, allow_self_modify)
        self.tools = build_registry()
        self.profiles = ProfileStore(self.data_dir)
        self.devices = DeviceStore(self.data_dir / "devices.json")
        self._settings_path = self.data_dir / "settings.json"
        self.settings = self._load_settings()
        perm = self.settings.get("permissions", {})
        self.permissions = PermissionEngine(self.policy, perm.get("mode", "manual"), perm.get("tool_settings"), perm.get("tool_rules"))
        self.terminals = TerminalManager(self.emit)
        self.export_tokens: dict[str, tuple[str, float]] = {}
        self.workspace: Workspace | None = None
        self._workspace_transition_lock = asyncio.Lock()
        self.connections: set[Connection] = set()
        self.agent: AgentRun | None = None
        self.pending_approvals: dict[str, dict] = {}
        self._approval_futures: dict[str, asyncio.Future] = {}
        self.pending_questions: dict[str, dict] = {}
        self._question_futures: dict[str, asyncio.Future] = {}
        self._terminals: dict[str, asyncio.Event] = {}
        self._watch_task: asyncio.Task | None = None
        self.preview = PreviewManager(self.data_dir, lan=lan, blocked_ports=(port,))

    # ---- settings ----------------------------------------------------------------------------
    def _load_settings(self) -> dict:
        try:
            return json.loads(self._settings_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_settings(self) -> None:
        self.settings["permissions"] = self.permissions.config()
        tmp = self._settings_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.settings, indent=1), encoding="utf-8")
        os.replace(tmp, self._settings_path)

    # ---- events --------------------------------------------------------------------------------
    def emit(self, event: str, data: dict | None = None) -> None:
        """Thread-safe broadcast to every connected client."""
        msg = {"type": "event", "event": event, "data": data or {}}
        if self.loop is None:
            return
        try:
            same = asyncio.get_running_loop() is self.loop
        except RuntimeError:
            same = False
        if same:
            self._broadcast(msg)
        else:
            self.loop.call_soon_threadsafe(self._broadcast, msg)

    def _broadcast(self, msg: dict) -> None:
        for c in list(self.connections):
            c.send(msg)

    def add_connection(self, c: Connection) -> None:
        self.connections.add(c)

    def remove_connection(self, c: Connection) -> None:
        self.connections.discard(c)
        c.close()

    def _on_change(self, change: Change) -> None:
        self.emit("fs.changed", change.to_dict())

    # ---- approvals -----------------------------------------------------------------------------
    def request_approval(self, payload: dict) -> asyncio.Future:
        aid = uuid.uuid4().hex[:10]
        payload = {**payload, "approval_id": aid}
        fut = self.loop.create_future()
        self._approval_futures[aid] = fut
        self.pending_approvals[aid] = payload

        def done(_):
            self._approval_futures.pop(aid, None)
            self.pending_approvals.pop(aid, None)
            self.emit("approval.resolved", {"approval_id": aid})
        fut.add_done_callback(done)
        self.emit("approval.request", payload)
        return fut

    def request_question(self, payload: dict) -> asyncio.Future:
        qid = uuid.uuid4().hex[:10]
        payload = {**payload, "question_id": qid}
        fut = self.loop.create_future()
        self._question_futures[qid] = fut
        self.pending_questions[qid] = payload

        def done(_):
            self._question_futures.pop(qid, None)
            self.pending_questions.pop(qid, None)
            self.emit("agent.question_resolved", {"question_id": qid})
        fut.add_done_callback(done)
        self.emit("agent.question", payload)
        return fut

    def approval_profile(self, main_profile: dict, main_key: str | None):
        pid = self.settings.get("approval_profile")
        if pid:
            try:
                return self.profiles.get(pid)
            except KeyError:
                pass
        return main_profile, main_key

    # ---- dispatch --------------------------------------------------------------------------------
    async def handle_message(self, conn: Connection, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if not isinstance(msg, dict) or msg.get("type") != "rpc":
            return
        mid, method, params = msg.get("id"), str(msg.get("method", "")), msg.get("params") or {}
        fn = getattr(self, "rpc_" + method.replace(".", "_"), None) if re.fullmatch(r"[a-z_.]+", method) else None

        def err(code, message, **data):
            conn.send({"type": "error", "id": mid, "error": {"code": code, "message": message, "data": data}})
        if fn is None:
            return err("METHOD_NOT_FOUND", f"unknown method {method}")
        try:
            if not isinstance(params, dict):
                raise WorkspaceError("BAD_REQUEST", "请求参数必须是对象")
            async def dispatch():
                if "workspace_key" in params:
                    current = Studio(self.workspace).workspace_key if self.workspace else None
                    if not isinstance(params["workspace_key"], str) or params["workspace_key"] != current:
                        raise WorkspaceError("WORKSPACE_CHANGED", "项目已切换，此次请求已取消", current_workspace_key=current)
                return await fn(params, conn)
            if method in {"workspace.open", "workspace.close", "agent.start", "terminal.run", "terminal.open"}:
                async with self._workspace_transition_lock:
                    result = await dispatch()
            else:
                result = await dispatch()
            conn.send({"type": "result", "id": mid, "result": result})
        except WorkspaceError as e:
            err(e.code, e.message, **e.data)
        except TrashError as e:
            err("TRASH_ERROR", str(e))
        except ProviderError as e:
            err("PROVIDER_ERROR", str(e))
        except (KeyError, ValueError, TypeError) as e:
            err("BAD_REQUEST", f"{type(e).__name__}: {e}")
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            err("INTERNAL", f"{type(e).__name__}: {e}")

    def _ws(self) -> Workspace:
        if self.workspace is None:
            raise WorkspaceError("NO_WORKSPACE", "请先打开一个项目文件夹")
        return self.workspace

    async def _call(self, fn, *a, **k):
        return await asyncio.to_thread(fn, *a, **k)

    # ---- hello / info ------------------------------------------------------------------------------
    async def rpc_hello(self, p, conn):
        return {
            "version": VERSION, "platform": platform.platform(), "python": platform.python_version(),
            "lan": self.lan, "workspace": self.workspace.info() if self.workspace else None,
            "permissions": {**self.permissions.config(), "modes": list(MODES), "tool_settings_options": list(TOOL_SETTINGS)},
            "profiles": self.profiles.list_public(),
            "presets": {k: {**v, "not_yet": False} for k, v in PRESETS.items()} | {k: {"not_yet": True} for k in NOT_YET},
            "agent": {"running": bool(self.agent), "task_id": self.agent.task_id if self.agent else None},
            "approvals": list(self.pending_approvals.values()),
            "questions": list(self.pending_questions.values()),
            "tools": [t.describe() for t in self.tools.all()], "recent": self.settings.get("recent", []),
            "agent_modes": list(MODE_CLASSES), "approval_profile": self.settings.get("approval_profile"),
        }

    # ---- workspace ------------------------------------------------------------------------------------
    async def rpc_workspace_open(self, p, conn):
        if self.agent:
            raise WorkspaceError("AGENT_BUSY", "先停止当前 AI 任务，再切换项目")
        roots = [Path(x).expanduser() for x in (p.get("paths") or [p["path"]])]

        def build():
            primary = roots[0].resolve()
            wid = hashlib.sha1(str(primary).encode()).hexdigest()[:12]
            w = Workspace(roots, CheckpointStore(self.data_dir / "checkpoints" / wid),
                          Trash(self.data_dir / "trash" / wid), self.policy)
            w.conversations = ConversationStore(self.data_dir / "conversations" / wid)
            return w
        ws = await self._call(build)
        if self.agent:
            raise WorkspaceError("AGENT_BUSY", "已有新的 AI 任务开始，未切换项目")
        await self._call(self.preview.close_all)
        for cancel in self._terminals.values():
            cancel.set()
        self.terminals.close_all()
        if self.workspace:
            self.workspace.listeners.clear()
        self.workspace = ws
        ws.listeners.append(self._on_change)
        if self._watch_task:
            self._watch_task.cancel()
        self._watch_task = asyncio.create_task(watcher.watch(
            ws.primary, lambda ch: self.emit("fs.external", {"changes": [{"path": a, "kind": b} for a, b in ch]})))
        recent = [str(ws.primary)] + [r for r in self.settings.get("recent", []) if r != str(ws.primary)]
        self.settings["recent"] = recent[:12]
        self._save_settings()
        self.emit("workspace.opened", ws.info())
        return ws.info()

    async def rpc_workspace_close(self, p, conn):
        if self.agent:
            self.agent.stop()
        await self._call(self.preview.close_all)
        for cancel in self._terminals.values():
            cancel.set()
        self.terminals.close_all()
        if self._watch_task:
            self._watch_task.cancel()
        self.workspace = None
        self.emit("workspace.closed", {})
        return {}

    async def shutdown(self) -> None:
        """Release project previews when the compatibility server is stopped."""
        if self.agent:
            self.agent.stop()
        if self._watch_task:
            self._watch_task.cancel()
        for cancel in self._terminals.values():
            cancel.set()
        self.terminals.close_all()
        await self._call(self.preview.close_all)

    async def rpc_workspace_remove_recent(self, p, conn):
        path = str(Path(p["path"]).expanduser().resolve())
        recent = [r for r in self.settings.get("recent", []) if str(Path(r).expanduser().resolve()) != path]
        self.settings["recent"] = recent
        self._save_settings()
        self.emit("workspace.recent_changed", {"recent": recent})
        return {"recent": recent}

    async def rpc_workspace_browse(self, p, conn):
        """Bridge-machine folder picker with a virtual level above filesystem roots/drives."""
        def locations():
            items = []
            seen = set()
            def add(name, path):
                try:
                    q = str(Path(path).expanduser().resolve())
                except OSError:
                    return
                if q in seen or not Path(q).is_dir():
                    return
                seen.add(q); items.append({"name": name, "path": q, "kind": "location"})
            if os.name == "nt":
                for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                    root = f"{letter}:\\"
                    if Path(root).is_dir(): add(f"{letter}: 盘", root)
            else:
                add("主文件系统 /", "/")
                add("主目录", "~")
                # 常见 Android / Termux 可访问位置；不存在的路径会自动跳过。
                for name, q in (("共享存储", "/storage/emulated/0"), ("内部存储", "/sdcard"), ("存储设备", "/storage")):
                    add(name, q)
            return items

        def go():
            raw = p.get("path")
            if raw == "__locations__":
                return {"path": "位置", "virtual": True, "parent": None, "dirs": [], "entries": locations(), "is_project": False}
            d = Path(raw or "~").expanduser().resolve()
            if not d.is_dir():
                raise WorkspaceError("NOT_A_FOLDER", f"{d} 不是文件夹")
            entries = []
            try:
                for c in sorted(d.iterdir(), key=lambda x: x.name.lower()):
                    if c.is_dir() and (p.get("show_hidden") or not c.name.startswith(".")):
                        entries.append({"name": c.name, "path": str(c), "kind": "folder"})
            except PermissionError:
                pass
            markers = {".git", "package.json", "pyproject.toml", "build.gradle", "pom.xml", "Cargo.toml", "go.mod"}
            parent = str(d.parent) if d.parent != d else "__locations__"
            return {"path": str(d), "virtual": False, "parent": parent, "dirs": [x["name"] for x in entries],
                    "entries": entries, "is_project": any((d / m).exists() for m in markers)}
        return await self._call(go)

    # ---- filesystem ----------------------------------------------------------------------------------------
    async def rpc_fs_read(self, p, conn):
        return await self._call(self._ws().read, p["path"])

    async def rpc_fs_tree(self, p, conn):
        return {"nodes": await self._call(self._ws().tree, p.get("path", "."), int(p.get("depth", 1)), bool(p.get("show_hidden")))}

    async def rpc_fs_search(self, p, conn):
        return await self._call(self._ws().search, p["query"], bool(p.get("regex")), p.get("glob"),
                                bool(p.get("case_sensitive")), int(p.get("max_results", 200)))

    async def rpc_fs_hash(self, p, conn):
        return await self._call(self._ws().hash, p["path"])

    async def rpc_fs_write(self, p, conn):
        return await self._call(self._ws().write, p["path"], p["content"], p.get("base_revision"), Ctx("user"))

    async def rpc_fs_patch(self, p, conn):
        return await self._call(self._ws().patch, p["path"], p.get("base_revision", ""), p["edits"], Ctx("user"))

    async def rpc_fs_create(self, p, conn):
        return await self._call(self._ws().create, p["path"], p.get("kind", "file"), p.get("content", ""), Ctx("user"))

    async def rpc_fs_delete(self, p, conn):
        return await self._call(self._ws().delete, p["path"], Ctx("user"))

    async def rpc_fs_rename(self, p, conn):
        return await self._call(self._ws().rename, p["from"], p["to"], Ctx("user"))

    async def rpc_fs_copy(self, p, conn):
        return await self._call(self._ws().copy, p["from"], p["to"], Ctx("user"))

    async def rpc_fs_begin_write(self, p, conn):
        return await self._call(self._ws().begin_write, p["path"], p.get("base_revision"), Ctx("user"))

    async def rpc_fs_write_chunk(self, p, conn):
        return await self._call(self._ws().write_chunk, p["write_id"], int(p["seq"]), p["data"], p.get("encoding", "utf-8"))

    async def rpc_fs_commit_write(self, p, conn):
        return await self._call(self._ws().commit_write, p["write_id"], int(p["total_bytes"]), p["sha256"])

    async def rpc_fs_abort_write(self, p, conn):
        return await self._call(self._ws().abort_write, p["write_id"])

    # ---- trash / checkpoints ------------------------------------------------------------------------------
    async def rpc_trash_list(self, p, conn):
        return {"items": await self._call(self._ws().trash.list)}

    async def rpc_trash_restore(self, p, conn):
        return await self._call(self._ws().restore_from_trash, p["id"])

    async def rpc_trash_delete(self, p, conn):
        await self._call(self._ws().trash.delete_permanently, p["id"])
        return {}

    async def rpc_trash_empty(self, p, conn):
        return {"removed": await self._call(self._ws().trash.empty)}

    async def rpc_checkpoint_tasks(self, p, conn):
        return {"tasks": await self._call(self._ws().checkpoints.list_tasks)}

    async def rpc_checkpoint_task(self, p, conn):
        m = await self._call(self._ws().checkpoints.load, p["task_id"])
        return {k: v for k, v in m.items()}

    async def rpc_checkpoint_diff(self, p, conn):
        return await self._call(self._ws().event_diff, p["task_id"], int(p["seq"]))

    async def rpc_checkpoint_revert_file(self, p, conn):
        return await self._call(self._ws().revert_file, p["task_id"], p["path"])

    async def rpc_checkpoint_revert_task(self, p, conn):
        return await self._call(self._ws().revert_task, p["task_id"])

    async def rpc_checkpoint_revert_event(self, p, conn):
        return await self._call(self._ws().revert_event, p["task_id"], int(p["seq"]), bool(p.get("force")))

    # ---- providers / permissions -----------------------------------------------------------------------------
    async def rpc_profiles_list(self, p, conn):
        return {"profiles": self.profiles.list_public()}

    async def rpc_profiles_save(self, p, conn):
        saved = self.profiles.save(p["profile"], p.get("api_key"))
        self.emit("profiles.changed", {"profiles": self.profiles.list_public()})
        return saved

    async def rpc_profiles_delete(self, p, conn):
        self.profiles.delete(p["id"])
        self.emit("profiles.changed", {"profiles": self.profiles.list_public()})
        return {}

    async def rpc_profiles_test(self, p, conn):
        profile, key = self.profiles.get(p["id"])
        provider = get_provider(profile["kind"])
        text = await asyncio.wait_for(provider.complete(profile, key, [{"role": "user", "content": "Reply with: ok"}]), 30)
        return {"ok": True, "reply": text[:80]}

    async def rpc_profiles_models(self, p, conn):
        """Discover models without forcing the user to save an unfinished provider profile first."""
        existing, stored_key = ({}, None)
        if p.get("id"):
            try:
                existing, stored_key = self.profiles.get(p["id"])
            except KeyError:
                pass
        profile = {**existing, **(p.get("profile") or {})}
        kind = profile.get("kind", "openai_compatible")
        preset = PRESETS.get(kind, {})
        profile["kind"] = kind
        profile["endpoint"] = profile.get("endpoint") or preset.get("endpoint", "")
        profile["model"] = profile.get("model") or preset.get("model", "")
        if not profile["endpoint"]:
            raise ValueError("请先填写接口地址")
        key = p.get("api_key") or stored_key
        models = await self._call(get_provider(kind).list_models, profile, key)
        return {"models": models}

    async def rpc_conversation_compact(self, p, conn):
        cid = p["conversation_id"]
        conv = self.workspace.conversations.get(cid)
        messages = self.workspace.conversations.as_messages(conv)
        if len(messages) < 2:
            raise ValueError("这段对话还太短，不需要压缩")
        profile, key = self.profiles.get(p["profile"])
        provider = get_provider(profile["kind"])
        transcript_text = "\n\n".join(f'{"用户" if m["role"] == "user" else "助手"}：{m["content"]}' for m in messages)
        prompt = ConversationStore.COMPACT_PROMPT + transcript_text
        summary = await asyncio.wait_for(provider.complete(profile, key, [{"role": "user", "content": prompt}]), 120)
        summary = summary.strip()
        if not summary:
            raise ProviderError("模型没有返回摘要，压缩已取消")
        self.workspace.conversations.compact(cid, summary)
        return {"summary": summary}

    async def rpc_permissions_set(self, p, conn):
        if "mode" in p:
            self.permissions.set_mode(p["mode"])
        for tool_id, setting in (p.get("tool_settings") or {}).items():
            self.permissions.set_tool(tool_id, setting)
        for tool_id, rules in (p.get("tool_rules") or {}).items():
            self.permissions.set_rules(tool_id, rules)
        if "approval_profile" in p:
            self.settings["approval_profile"] = p["approval_profile"] or None
        self._save_settings()
        self.emit("permissions.changed", self.permissions.config())
        return self.permissions.config()

    async def rpc_approval_respond(self, p, conn):
        fut = self._approval_futures.get(p["approval_id"])
        if fut and not fut.done():
            fut.set_result({"allow": bool(p.get("allow")), "scope": p.get("scope", "once")})
        return {}

    async def rpc_agent_answer(self, p, conn):
        fut = self._question_futures.get(p["question_id"])
        pending = self.pending_questions.get(p["question_id"])
        n = len(pending["questions"]) if pending and pending.get("questions") else 1
        answers = p.get("answers")
        if answers is None and p.get("answer") is not None:
            answers = [p["answer"]]  # back-compat: a single-question client answering the old way
        answers = [str(a or "").strip() for a in (answers or [])]
        if len(answers) != n or any(not a for a in answers):
            raise ValueError("每个问题都需要一个回答")
        if fut and not fut.done():
            fut.set_result(answers)
        return {}

    async def rpc_instructions_constitution(self, p, conn):
        return {"text": AIMO_CONSTITUTION}

    # ---- agent ------------------------------------------------------------------------------------------------------
    async def rpc_agent_start(self, p, conn):
        self._ws()
        if self.agent:
            raise WorkspaceError("BUSY", "已有智能体任务正在运行")
        mode = p.get("mode", "agent")
        if mode not in MODE_CLASSES:
            raise ValueError(f"未知的模式：{mode}")
        limits = {k: v for k, v in (p.get("limits") or {}).items() if k in ("max_tool_calls", "max_seconds", "max_repair_attempts", "max_tokens", "max_cost_usd", "max_repeated_failures")}
        from .providers.media import validate_start
        profile, _ = self.profiles.get(p["profile"])
        attachments = validate_start(profile, p.get("attachments"), limits)
        store = self.workspace.conversations
        cid = p.get("conversation_id")
        if cid:
            try:
                store.get(cid)
            except KeyError:
                cid = None
        if not cid:
            cid = store.create(p["goal"])["id"]
        run = AgentRun(self, p["goal"], mode, p["profile"], limits, conversation_id=cid, reasoning=p.get("reasoning", "auto"), web_search=bool(p.get("web_search")), attachments=attachments)
        self.agent = run

        async def go():
            try:
                await run.run()
            finally:
                self.agent = None
        asyncio.create_task(go())
        return {"started": True, "conversation_id": cid}

    async def rpc_agent_stop(self, p, conn):
        if self.agent:
            self.agent.stop()
        return {"stopping": bool(self.agent)}

    # ---- terminal (user-run commands) ---------------------------------------------------------------------------------
    async def rpc_studio_read(self, p, conn):
        return await self._call(Studio(self._ws()).read)

    async def rpc_studio_write(self, p, conn):
        return await self._call(Studio(self._ws()).write, p.get("data"), p.get("base_revision"))

    async def rpc_studio_revision(self, p, conn):
        return await self._call(Studio(self._ws()).revision)

    async def rpc_launch_inspect(self, p, conn):
        return await self._call(Studio(self._ws()).inspect_launch)

    async def rpc_experiments_list(self, p, conn):
        return await self._call(Studio(self._ws()).experiments_list)

    async def rpc_experiments_create(self, p, conn):
        return await self._call(Studio(self._ws()).experiments_create, p["name"], p.get("baseline_id"))

    async def rpc_experiments_diff(self, p, conn):
        return await self._call(Studio(self._ws()).experiments_diff, p["id"])

    async def rpc_experiments_apply(self, p, conn):
        if self.agent:
            raise WorkspaceError("BUSY", "先停止 AI 任务再应用方案")
        return await self._call(Studio(self._ws()).experiments_apply, p["id"])

    async def rpc_preview_open(self, p, conn):
        self._ws()
        return await self._call(self.preview.open, p["url"], p.get("public_host"))

    async def rpc_preview_close(self, p, conn):
        return await self._call(self.preview.close, p["id"])

    async def rpc_preview_capture(self, p, conn):
        return await self._call(self.preview.capture, p["id"], p.get("width", 1280), p.get("height", 800))

    async def rpc_studio_apply_edits(self, p, conn):
        if self.agent:
            raise WorkspaceError("AGENT_BUSY", "先停止 AI 任务再应用语言服务修改")
        ws = self._ws()
        files = p.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= 200:
            raise WorkspaceError("BAD_EDIT", "批量修改需要 1 到 200 个文件")
        def apply():
            with ws._lock:
                if self.workspace is not ws:
                    raise WorkspaceError("CONFLICT", "项目已切换，语言服务修改已取消")
                if self.agent:
                    raise WorkspaceError("AGENT_BUSY", "先停止 AI 任务再应用语言服务修改")
                seen: set[Path] = set()
                checked: list[dict] = []
                for f in files:
                    if not isinstance(f, dict) or not isinstance(f.get("content"), str) or not isinstance(f.get("revision"), str):
                        raise WorkspaceError("BAD_EDIT", "修改内容和基础版本无效")
                    path = f.get("path")
                    if not isinstance(path, str):
                        raise WorkspaceError("BAD_EDIT", "路径无效或重复")
                    target = ws.resolve(path, "write")
                    verdict = ws.policy.check_path(target, "write")
                    if verdict:
                        raise WorkspaceError("POLICY_DENIED", verdict.reason, path=path)
                    if target in seen:
                        raise WorkspaceError("BAD_EDIT", "批量修改的多个路径指向同一文件", path=path)
                    seen.add(target)
                    if len(f["content"].encode("utf-8")) > 8 * 1024 * 1024:
                        raise WorkspaceError("TOO_LARGE", "单个修改文件超过 8 MiB")
                    before = ws.read(path)
                    if before.get("binary"):
                        raise WorkspaceError("BAD_EDIT", "不能对二进制文件执行语言重命名", path=path)
                    if before["revision"] != f["revision"]:
                        raise WorkspaceError("REVISION_CONFLICT", "批量修改的基础版本已过期", path=path)
                    checked.append({**f, "path": ws.display(target)})
                task = ws.checkpoints.start_task(p.get("label", "语言服务重命名"), "edit")
                try:
                    for f in checked:
                        ws.write(f["path"], f["content"], f["revision"], Ctx("user", task["id"]))
                    ws.checkpoints.finish_task(task["id"], "done", "语言服务修改已应用")
                except Exception:
                    ws.checkpoints.finish_task(task["id"], "error", "部分修改可能已应用，可从任务检查点恢复")
                    raise
                return {"task_id": task["id"], "files": len(files)}
        return await self._call(apply)

    async def rpc_terminal_run(self, p, conn):
        ws = self._ws()
        cmd = p["command"]
        if not isinstance(cmd, str) or not cmd.strip():
            raise WorkspaceError("BAD_COMMAND", "命令不能为空，且必须是字符串")
        verdict = self.policy.check_command(cmd)
        if verdict and verdict.action == "deny":
            raise WorkspaceError("POLICY_DENIED", verdict.reason)
        cwd = ws.resolve(p.get("cwd") or ".", "read")
        if not cwd.is_dir():
            raise WorkspaceError("BAD_PATH", "命令工作目录必须是工作区内的文件夹")
        tid, cancel = uuid.uuid4().hex[:8], asyncio.Event()
        self._terminals[tid] = cancel

        async def go():
            self.emit("terminal.start", {"source": "user", "id": tid, "command": cmd})
            try:
                res = await run_shell(cmd, str(cwd), float(p.get("timeout_seconds", 600)), cancel,
                                      lambda s, t: self.emit("terminal.output", {"source": "user", "id": tid, "stream": s, "data": t}))
                self.emit("terminal.exit", {"source": "user", "id": tid, "exit_code": res["exit_code"],
                                            "timed_out": res["timed_out"], "cancelled": res["cancelled"]})
            except Exception as error:
                self.emit("terminal.exit", {"source": "user", "id": tid, "exit_code": -1, "timed_out": False,
                                            "cancelled": cancel.is_set(), "error": {"code": "PROCESS_START_FAILED", "message": str(error)}})
            finally:
                self._terminals.pop(tid, None)
        asyncio.create_task(go())
        return {"id": tid}

    async def rpc_terminal_kill(self, p, conn):
        ev = self._terminals.get(p["id"])
        if ev:
            ev.set()
        return {}

    # ---- Git ---------------------------------------------------------------------------------------------------------
    def _git_call(self, fn, *a, **k):
        try:
            return fn(self._ws().primary, *a, **k)
        except gitops.GitError as e:
            raise WorkspaceError("GIT_ERROR", str(e))

    def _gitpath(self, path: str) -> str:
        ws = self._ws()
        real = ws.resolve(path, "read")
        try:
            return real.relative_to(ws.primary).as_posix()
        except ValueError:
            raise WorkspaceError("OUTSIDE_WORKSPACE", f"{path} 不在主项目文件夹里")

    async def rpc_git_status(self, p, conn):
        return await self._call(self._git_call, gitops.status)

    async def rpc_git_diff(self, p, conn):
        return {"diff": await self._call(self._git_call, gitops.diff, self._gitpath(p["path"]), bool(p.get("staged")))}

    async def rpc_git_stage(self, p, conn):
        await self._call(self._git_call, gitops.stage, [self._gitpath(x) for x in p["paths"]])
        self.emit("git.changed", {})
        return {}

    async def rpc_git_unstage(self, p, conn):
        await self._call(self._git_call, gitops.unstage, [self._gitpath(x) for x in p["paths"]])
        self.emit("git.changed", {})
        return {}

    async def rpc_git_discard(self, p, conn):
        if not p.get("confirm"):
            raise WorkspaceError("NEEDS_CONFIRM", "丢弃改动需要明确确认")
        rel = self._gitpath(p["path"])
        st = await self._call(self._git_call, gitops.status)
        entry = next((f for f in st.get("files", []) if f["path"] == rel), None)
        if entry and entry["index"] == "?":                       # 未跟踪的新文件：移到回收站，不是永久删除
            await self._call(self._ws().delete, rel, Ctx("user"))
        else:
            await self._call(self._git_call, gitops.discard_tracked, rel)
            self.emit("fs.external", {"changes": [{"path": rel, "kind": "modify"}]})
        self.emit("git.changed", {})
        return {}

    def _git_force_reset(self, ref: str) -> str:
        """Restore the selected commit through Workspace mutations, then move HEAD/index.

        This intentionally does not call `git reset --hard`: every destructive filesystem change is
        recoverable through Diffusion Trash and goes through the workspace sandbox.
        """
        ws = self._ws()
        root = ws.primary
        commit = self._git_call(gitops.resolve_commit, ref)
        target = self._git_call(gitops.tree, commit)
        current = self._git_call(gitops.tracked_modes)
        bad = [path for path, item in target.items() if item.get("type") != "blob" or item.get("mode") in ("120000", "160000")]
        bad += [path for path, mode in current.items() if mode in ("120000", "160000")]
        if bad:
            raise WorkspaceError("GIT_UNSUPPORTED_ENTRY", "这个版本包含符号链接或子模块，暂不能在图形界面强制回退；请使用终端处理")
        # Never let a live symlink redirect the protected restore outside the workspace.
        for rel in set(current) | set(target):
            if os.path.lexists(root / rel) and (root / rel).is_symlink():
                raise WorkspaceError("GIT_UNSUPPORTED_ENTRY", f"{rel} 当前是符号链接，无法安全地强制回退")
        ctx = Ctx("user")
        target_paths = set(target)
        current_paths = set(current)
        # Remove tracked files that did not exist at the target commit.
        for rel in sorted(current_paths - target_paths, key=lambda x: (x.count("/"), len(x)), reverse=True):
            q = root / rel
            if os.path.lexists(q):
                ws.delete(rel, ctx)
        # Restore every target blob. Any content that would be overwritten is first moved to
        # Diffusion Trash, so the UI's “强制回退” remains recoverable instead of silently
        # behaving like raw `git reset --hard`.
        for rel, item in target.items():
            q = root / rel
            target_bytes = self._git_call(gitops.blob, item["sha"])
            if os.path.lexists(q) and rel not in current_paths:
                ws.delete(rel, ctx)
            elif q.exists() and q.is_dir():
                ws.delete(rel, ctx)
            elif q.is_file():
                try:
                    differs = q.read_bytes() != target_bytes
                except OSError:
                    differs = True
                if differs:
                    ws.delete(rel, ctx)
            ws.write_bytes(rel, target_bytes, None, ctx)
            ws.set_executable(rel, item["mode"] == "100755")
        self._git_call(gitops.reset_mixed, commit)
        return commit

    async def rpc_git_reset(self, p, conn):
        mode = p.get("mode", "soft")
        ref = p["hash"]
        if mode not in ("soft", "hard"):
            raise ValueError("回退方式只能是 soft 或 hard")
        if mode == "hard" and not p.get("confirm"):
            raise WorkspaceError("NEEDS_CONFIRM", "强制回退会恢复工作区文件，需要明确确认")
        if mode == "soft":
            commit = await self._call(self._git_call, gitops.reset_soft, ref)
        else:
            commit = await self._call(self._git_force_reset, ref)
        self.emit("git.changed", {})
        self.emit("fs.external", {"changes": []})
        return {"hash": commit, "mode": mode}

    async def rpc_git_commit(self, p, conn):
        h = await self._call(self._git_call, gitops.commit, p["message"])
        self.emit("git.changed", {})
        return {"hash": h}

    async def rpc_git_branches(self, p, conn):
        return {"branches": await self._call(self._git_call, gitops.branches)}

    async def rpc_git_checkout(self, p, conn):
        await self._call(self._git_call, gitops.checkout, p["name"], bool(p.get("create")))
        self.emit("git.changed", {})
        self.emit("fs.external", {"changes": []})
        return {}

    async def rpc_git_log(self, p, conn):
        path = self._gitpath(p["path"]) if p.get("path") else None
        return {"commits": await self._call(self._git_call, gitops.log, int(p.get("limit", 50)), path)}

    async def rpc_git_blame(self, p, conn):
        return {"lines": await self._call(self._git_call, gitops.blame, self._gitpath(p["path"]))}

    async def rpc_git_pull(self, p, conn):
        out = await self._call(self._git_call, gitops.pull)
        self.emit("git.changed", {})
        self.emit("fs.external", {"changes": []})
        return {"output": out}

    async def rpc_git_push(self, p, conn):
        return {"output": await self._call(self._git_call, gitops.push)}

    async def rpc_git_init(self, p, conn):
        await self._call(self._git_call, gitops.init)
        self.emit("git.changed", {})
        return {}

    # ---- 交互式终端（PTY）与端口 -----------------------------------------------------------------------------------------
    async def rpc_terminal_open(self, p, conn):
        ws = self._ws()
        try:
            s = self.terminals.open(str(ws.primary), int(p.get("cols") or 80), int(p.get("rows") or 24))
        except PtyUnavailable as e:
            raise WorkspaceError("NO_PTY", str(e))
        except RuntimeError as e:
            raise WorkspaceError("TOO_MANY", str(e))
        return {"id": s.sid, "pid": s.pid, "shell": s.shell}

    def _term(self, sid):
        s = self.terminals.get(sid)
        if not s:
            raise WorkspaceError("NO_SUCH_TERMINAL", "这个终端已经不存在")
        return s

    async def rpc_terminal_input(self, p, conn):
        self._term(p["id"]).write(str(p["data"])[:65536])
        return {}

    async def rpc_terminal_resize(self, p, conn):
        self._term(p["id"]).resize(int(p["cols"]), int(p["rows"]))
        return {}

    async def rpc_terminal_close(self, p, conn):
        self.terminals.close(p["id"])
        return {}

    async def rpc_terminal_list(self, p, conn):
        return {"sessions": self.terminals.list()}

    async def rpc_terminal_history(self, p, conn):
        s = self._term(p["id"])
        return {"data": s.ring, "alive": s.alive}

    async def rpc_ports_list(self, p, conn):
        return {"ports": await self._call(listening_ports)}

    # ---- 导出 / 会话 / 全局指令 ----------------------------------------------------------------------------------------------
    async def rpc_fs_export(self, p, conn):
        ws = self._ws()
        target = ws.resolve(p.get("path") or ".", "read")
        if not target.exists():
            raise WorkspaceError("NOT_FOUND", f"{p.get('path')} 不存在")
        now = time.time()
        self.export_tokens = {k: v for k, v in self.export_tokens.items() if v[1] > now}
        token = secrets.token_urlsafe(16)
        self.export_tokens[token] = (str(target), now + 120)          # 一次性、2 分钟内有效
        return {"url": f"/api/export?t={token}", "name": (target.name or "project") + ".zip"}

    async def rpc_conv_list(self, p, conn):
        return {"conversations": await self._call(self._ws().conversations.list)}

    async def rpc_conv_get(self, p, conn):
        return await self._call(self._ws().conversations.get, p["id"])

    async def rpc_conv_delete(self, p, conn):
        await self._call(self._ws().conversations.delete, p["id"])
        return {}

    async def rpc_instructions_get(self, p, conn):
        g = self.data_dir / "global_instructions.md"
        out = {"global": g.read_text("utf-8", "replace") if g.is_file() else "", "project_exists": False, "project": ""}
        if self.workspace:
            a = self.workspace.primary / "AGENTS.md"
            if a.is_file():
                out["project_exists"], out["project"] = True, a.read_text("utf-8", "replace")[:8000]
        return out

    async def rpc_instructions_set(self, p, conn):
        text = str(p.get("global", ""))
        if len(text) > 20000:
            raise ValueError("全局指令太长（上限 20000 字）")
        (self.data_dir / "global_instructions.md").write_text(text, encoding="utf-8")
        return {}

    # ---- devices ---------------------------------------------------------------------------------------------------------
    def _require_local(self, conn):
        if conn.peer not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            raise WorkspaceError("LOCAL_ONLY", "只有运行桥接服务的这台电脑才能管理设备")

    async def rpc_devices_pair_code(self, p, conn):
        self._require_local(conn)
        if not self.lan:
            raise WorkspaceError("LAN_OFF", "请用 --lan 参数启动桥接服务，才能配对其他设备")
        return {"code": self.devices.new_code(), "expires_in": 300, "port": self.port, "addresses": lan_addresses()}

    async def rpc_devices_list(self, p, conn):
        self._require_local(conn)
        return {"devices": self.devices.list()}

    async def rpc_devices_revoke(self, p, conn):
        self._require_local(conn)
        return {"revoked": self.devices.revoke(p["id"])}
