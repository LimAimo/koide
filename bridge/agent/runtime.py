"""Agent runtime: model turn -> tool calls -> permission -> execute -> result -> next turn.

Every step is observable (events), controllable (Stop, approvals, limits) and undoable (task checkpoint).
"""
from __future__ import annotations

import asyncio
import json
import platform
import re
import time
from pathlib import Path

from ..filesystem.workspace import Ctx, WorkspaceError
from ..providers.openai_compat import ProviderError, get_provider
from ..tools.builtin import ToolContext
from ..tools.registry import validate
from .approval import make_reviewer
from .constitution import AIMO_CONSTITUTION

MODE_CLASSES = {
    "chat": {"interaction"},
    "read": {"read", "interaction"},
    "edit": {"read", "write", "delete", "interaction"},
    "agent": {"read", "write", "delete", "exec", "network", "interaction"},
}
MAX_RESULT_CHARS = 30_000

SYSTEM_PROMPT = """You are Diffusion, an AI coding agent working inside the user's local project.

CRITICAL RULE — ACT, DON'T NARRATE:
- You have no hands other than tool calls. Describing an action in your prose ("I'll read the file now",
  "Let me run the tests", "I have fixed the bug", "Done, the file now contains...") does NOT perform that
  action. If a step involves the filesystem, the shell, the terminal, the network or asking the user
  something, the ONLY way it happens is a real tool call in this same turn — never assume it happened
  because you wrote a sentence about it.
- Never claim a file was read, edited, created or a command was run unless you actually called the
  matching tool and saw its result. Never report "已完成/已修复/完成了" (done/fixed/finished) about a
  concrete change unless a tool call for that exact change already returned success in this conversation.
  A confident-sounding summary is not evidence; only a tool result is.
- If your plan is to do N things, call the tool for the first thing immediately — do not first write out
  the whole plan in prose and stop without calling anything. When you say what you are about to do, that
  sentence must be followed by the tool call for it in the same turn, not by silence.
- Only stop making tool calls once every concrete part of the task has been done via a tool and verified
  (e.g. re-read the file, or ran the build/tests) — or once you must ask the user something first via
  ask_user, or once you are only reporting results with nothing left to change.
- If you are unsure whether an action already happened, re-check with a read-only tool (fs_read, fs_list,
  fs_search, terminal_read) rather than guessing from memory.

How to work:
- Explore first: fs_list, fs_search or fs_glob, then fs_read (or fs_multi_read for several files at once)
  the files that matter.
- Edit with fs_patch using small exact edits (old_text must match exactly once). Read a file before patching it.
  If a patch fails with CONFLICT or NO_MATCH, re-read the file and try again.
- Verify your work: run the project's build or tests with shell_run, read the errors, fix them, run again.
  A task is not finished just because you stopped generating tool calls — it is finished when the tool
  results show it working.
- Stay inside the workspace. Never try to read secrets, and never modify the Diffusion Bridge itself.
- Keep messages concise unless the task needs detail. When finished, summarise what you changed and why,
  citing what the tool results actually showed (e.g. which tests passed).
- If an important choice or missing fact cannot be inferred safely, use ask_user instead of guessing. If
  you have more than one thing to ask, put them all in a single ask_user call (its `questions` array can
  hold several) so the user answers them together in one place — do not call ask_user repeatedly for
  related questions.
- Reply in the same language the user writes in (if they write Chinese, answer in Chinese).

SCOPE — what you can and cannot do:
- You can, using tools: read/list/search/glob files, read several files in one call, edit files with exact
  patches, write or delete files, rename/move files, run shell commands (build, test, lint, git, package
  managers, etc.) and read terminal output, fetch a public web page's text (http/https only), and ask the
  user questions. Everything you do to the project must go through one of these tools.
- You cannot: edit files outside the workspace root, read or exfiltrate credentials/secrets/.env-like
  files unless the user's task is specifically about them, modify the Diffusion Bridge application itself,
  reach the bridge machine's own network (localhost/private addresses) with web_fetch, install or run
  anything requiring interactive/TTY input the shell tool can't supply, or take any action a permission
  decision has denied — a denial is final for that call, not something to route around with a different
  tool or a rephrased command.
- Your available tools depend on the current mode ({mode}): {mode_scope}. If a needed capability isn't
  listed, say so plainly instead of attempting a workaround, and suggest the user switch modes if that
  would unblock the task.

Workspace root: {root}
Operating system: {os}
"""


class Stopped(Exception):
    pass


class LimitReached(Exception):
    pass


def _clip(text: str, n: int = MAX_RESULT_CHARS) -> str:
    return text if len(text) <= n else text[:n] + f"\n...[truncated {len(text) - n} characters]"


def _native_string_arg(raw: str, key: str) -> str | None:
    """Extract a *completed* JSON string field from native tool-argument stream data.

    This is never applied to assistant prose. It only reads provider-native tool argument chunks and
    returns a human label; the raw JSON is intentionally never sent to the UI.
    """
    m = re.search(r'"' + re.escape(key) + r'"\s*:\s*"((?:\\.|[^"\\])*)"', raw)
    if not m:
        return None
    try:
        return json.loads('"' + m.group(1) + '"')
    except Exception:
        return None


def _tool_label(name: str, tool) -> str:
    """Human-readable name for a tool. Never falls back to the raw internal tool id (e.g. `fs_patch`) —
    that is an implementation detail, not something a person reading the status line should see."""
    if tool is not None and tool.display_name:
        return tool.display_name
    return "工具" if not name else name


def _tool_progress(name: str, raw: str, tool=None) -> tuple[str, str]:
    label = _tool_label(name, tool)
    fields = []
    for key, zh in (("path", "目标"), ("from", "来源"), ("to", "目标"), ("query", "搜索"), ("pattern", "匹配"),
                     ("paths", "文件"), ("url", "网址"), ("command", "命令"), ("question", "问题")):
        value = _native_string_arg(raw, key)
        if value:
            fields.append(f"{zh}：{value[:160]}")
    if name == "fs_patch":
        n = len(re.findall(r'"old_text"\s*:', raw))
        if n:
            fields.append(f"修改片段：{n} 处")
    detail = " · ".join(fields) if fields else "模型正在准备调用参数…"
    return f"准备{label}", detail


class AgentRun:
    def __init__(self, app, goal: str, mode: str, profile_id: str, limits: dict | None = None, conversation_id: str | None = None, reasoning: str = "auto", web_search: bool = False):
        self.app, self.goal, self.mode, self.profile_id = app, goal, mode, profile_id
        self.conversation_id = conversation_id
        self.reasoning = reasoning if reasoning in ("auto", "on", "off") else "auto"
        self.web_search = bool(web_search)
        self.transcript: list[dict] = []
        self.limits = {"max_tool_calls": 0, "max_seconds": 0, "max_repair_attempts": 8, **(limits or {})}
        self.cancel = asyncio.Event()
        self.task_id: str | None = None
        self.read_revisions: dict[str, str] = {}
        self.tool_calls = 0
        self.failed_runs = 0
        self.started = 0.0
        self.last_text = ""

    # ------------------------------------------------------------------------------------------
    def stop(self) -> None:
        self.cancel.set()

    def _emit(self, event: str, **data) -> None:
        self.app.emit(event, {"task_id": self.task_id, **data})

    def _status(self, state: str, detail: str = "") -> None:
        self._emit("agent.status", state=state, detail=detail)

    def _system_prompt(self) -> str:
        ws = self.app.workspace
        scopes = {
            "chat": "只能对话和向你提问，不能读写文件、不能跑命令",
            "read": "可以读文件、列目录、搜索/查找文件、向你提问，但不能修改任何文件、不能跑命令",
            "edit": "可以读写文件（含新建、删除、改名）、向你提问，但不能跑 shell 命令、不能访问网络",
            "agent": "可以读写文件、跑 shell 命令、读取终端、访问网页（web_fetch）、向你提问——权限最完整",
        }
        text = SYSTEM_PROMPT.format(root=ws.primary, os=platform.platform(), mode=self.mode,
                                    mode_scope=scopes.get(self.mode, scopes["agent"]))
        text += "\n# Aimo 宪法（内置行为原则，完整遵守）\n" + AIMO_CONSTITUTION
        glob = self.app.data_dir / "global_instructions.md"
        if glob.is_file():
            text += "\n# Global instructions\n" + glob.read_text("utf-8", "replace")[:6000]
        project_context = ws.project_context()
        if project_context:
            text += "\n" + project_context
        return text

    def _check_limits(self) -> None:
        if self.cancel.is_set():
            raise Stopped()
        max_calls = float(self.limits.get("max_tool_calls") or 0)
        if max_calls > 0 and self.tool_calls >= max_calls:
            raise LimitReached(f"已停止：工具调用次数达到上限（{self.limits['max_tool_calls']} 次）")
        max_seconds = float(self.limits.get("max_seconds") or 0)
        if max_seconds > 0 and time.monotonic() - self.started > max_seconds:
            raise LimitReached(f"已停止：运行时间超过上限（{self.limits['max_seconds']} 秒）")
        if self.failed_runs > self.limits["max_repair_attempts"]:
            raise LimitReached(f"已停止：构建或测试已失败 {self.failed_runs} 次（修复尝试次数上限）")

    # ------------------------------------------------------------------------------------------
    async def run(self) -> None:
        app = self.app
        ws = app.workspace
        status, summary = "done", ""
        self.started = time.monotonic()
        task = ws.checkpoints.start_task(self.goal, self.mode)
        self.task_id = task["id"]
        self._emit("agent.started", goal=self.goal, mode=self.mode)
        try:
            profile, key = app.profiles.get(self.profile_id)
            profile = {**profile, "_reasoning_mode": self.reasoning, "_web_search": self.web_search}
            provider = get_provider(profile["kind"])
            tools = app.tools.for_classes(MODE_CLASSES[self.mode])
            by_id = {t.id: t for t in tools}
            specs = app.tools.openai_specs(tools) if tools else None
            reviewer = None
            if app.permissions.mode == "ai" or "ai_review" in app.permissions.tool_settings.values():
                rp, rk = app.approval_profile(profile, key)
                reviewer = make_reviewer(get_provider(rp["kind"]), rp, rk, ws, self.goal,
                                         app.permissions.config(), lambda: self.last_text[-600:])
            history = []
            if self.conversation_id and getattr(ws, "conversations", None):
                try:
                    history = ws.conversations.as_messages(ws.conversations.get(self.conversation_id))
                except KeyError:
                    history = []
            self.transcript.append({"role": "user", "text": self.goal, "ts": time.time()})
            messages = [{"role": "system", "content": self._system_prompt()}, *history,
                        {"role": "user", "content": self.goal}]
            while True:
                self._check_limits()
                self._status("thinking")
                text, calls = await self._model_turn(provider, profile, key, messages, specs, by_id)
                if self.cancel.is_set():
                    raise Stopped()
                self.last_text = text or self.last_text
                if text.strip():
                    self.transcript.append({"role": "assistant", "text": text, "ts": time.time()})
                assistant = {"role": "assistant", "content": text or None}
                if calls:
                    assistant["tool_calls"] = [
                        {"id": c["id"], "type": "function",
                         "function": {"name": c["name"], "arguments": json.dumps(c["arguments"] or {}),
                                     **(c.get("extra_fn") or {})},
                         **(c.get("extra_tc") or {})}
                        for c in calls]
                messages.append(assistant)
                if not calls:
                    summary = text
                    break
                for call in calls:
                    result = await self._execute(call, by_id, reviewer)
                    messages.append({"role": "tool", "tool_call_id": call["id"],
                                     "content": _clip(json.dumps(result, ensure_ascii=False))})
                    self._check_limits()
            # A turn with no tool calls at all is normally a genuine "I'm done" — but a weak model can also
            # just stop mid-task without having done anything, and that must not look like success.
            if self.mode != "chat" and self.tool_calls == 0:
                status = "incomplete"
                if not summary.strip():
                    summary = "模型没有调用任何工具就结束了对话——这次大概率什么都没做。你可以点击「继续」让它接着做，或换一种说法重新描述任务。"
        except Stopped:
            status, summary = "stopped", "已由你停止"
        except LimitReached as e:
            status, summary = "stopped", str(e)
            self._emit("agent.message", delta=f"\n\n{summary}")
        except (ProviderError, KeyError) as e:
            status, summary = "error", str(e)
        except Exception as e:  # never let a bug take the Bridge down
            status, summary = "error", f"{type(e).__name__}: {e}"
        finally:
            if self.conversation_id and getattr(ws, "conversations", None):
                try:
                    ws.conversations.append(self.conversation_id, self.transcript + [{"role": "note", "text": {"done": "任务完成", "incomplete": "任务可能未完成", "stopped": "任务已停止", "error": "任务失败"}[status], "task_id": self.task_id, "status": status, "ts": time.time()}])
                except KeyError:
                    pass
            ws.checkpoints.finish_task(self.task_id, status, summary)
            self._emit("agent.done", status=status, summary=summary)
            self._status({"done": "idle", "incomplete": "idle", "stopped": "stopped", "error": "error"}[status], summary if status in ("error", "incomplete") else "")

    async def _model_turn(self, provider, profile, key, messages, specs, by_id):
        text, calls, preparing = [], [], {}
        async for ev in provider.stream_chat(profile, key, messages, specs, self.cancel):
            t = ev["type"]
            if t == "text":
                text.append(ev["delta"])
                self._emit("agent.message", delta=ev["delta"])
            elif t == "reasoning":
                self._emit("agent.reasoning", delta=ev["delta"])
            elif t == "tool_call_delta":
                idx = ev["index"]
                current = preparing.setdefault(idx, {"id": None, "name": "", "args": "", "last": None})
                if ev.get("name"):
                    current["name"] = ev["name"]
                if ev.get("args_chunk"):
                    current["args"] += ev["args_chunk"]
                actual = ev.get("id")
                old_id = current["id"]
                cid = actual or old_id or f"prepare_{self.task_id}_{idx}"
                current["id"] = cid
                name = current["name"]
                if not name:
                    continue
                tool = by_id.get(name)
                title, detail = _tool_progress(name, current["args"], tool)
                snapshot = (cid, name, title, detail)
                if snapshot != current["last"]:
                    self._emit("agent.tool", call_id=cid,
                               replace_call_id=old_id if old_id and old_id != cid else None,
                               tool=name, state="preparing", title=title, detail=detail,
                               summary=(detail if detail != "模型正在准备调用参数…" else "接收参数…"),
                               activity=tool.activity if tool else "working")
                    current["last"] = snapshot
                self._status(tool.activity if tool else "working", title)
            elif t == "tool_call_complete":
                prep = preparing.get(ev.get("index"))
                ev["_prepare_id"] = prep["id"] if prep else None
                calls.append(ev)
            elif t == "error":
                raise ProviderError(ev["message"])
        self._emit("agent.turn_end")
        return "".join(text), calls

    # ------------------------------------------------------------------------------------------
    async def _execute(self, call: dict, by_id: dict, reviewer) -> dict:
        app, ws = self.app, self.app.workspace
        name, cid = call["name"], call["id"]
        tool = by_id.get(name)

        prepare_id = call.get("_prepare_id")
        first_card = True

        def card(state: str, **kw):
            nonlocal first_card
            extra = {}
            if first_card and prepare_id and prepare_id != cid:
                extra["replace_call_id"] = prepare_id
            first_card = False
            self._emit("agent.tool", call_id=cid, tool=name, state=state, **extra, **kw)

        if tool is None:
            card("error", title=_tool_label(name, None), detail="当前模式下没有这个工具")
            return {"error": {"code": "UNKNOWN_TOOL", "message": f"tool '{name}' is not available"}}
        if call.get("error"):
            card("error", title=_tool_label(name, None), detail=call["error"])
            return {"error": {"code": "BAD_ARGUMENTS", "message": call["error"]}}
        args = call["arguments"]
        errs = validate(tool.input_schema, args)
        if errs:
            card("error", title=tool.title(args) or _tool_label(name, tool), detail="; ".join(errs[:3]))
            return {"error": {"code": "SCHEMA_VALIDATION", "message": "; ".join(errs)}}

        title = tool.title(args) or _tool_label(name, tool)
        card("pending", title=title, args=args, activity=tool.activity)
        self.tool_calls += 1

        decision = await app.permissions.evaluate(tool, args, ws, reviewer, {"task": self.goal})
        if decision.action == "deny":
            card("denied", title=title, detail=decision.reason)
            return {"error": {"code": "DENIED", "message": decision.reason}}
        if decision.action == "ask":
            self._status("waiting_approval", title)
            card("waiting", title=title, detail=decision.reason)
            answer = await self._ask_user(tool, args, title, decision, cid)
            if not answer.get("allow"):
                card("denied", title=title, detail="你已拒绝")
                return {"error": {"code": "USER_DECLINED", "message": "The user declined this action."}}
            if answer.get("scope") == "session" and decision.source != "hard_policy":
                app.permissions.grant_session(tool.id)

        self._status(tool.activity, title)
        card("running", title=title)
        async def ask_question(payload: dict) -> list[str]:
            qs = payload.get("questions") or []
            status_text = qs[0]["question"] if len(qs) == 1 else f"{len(qs)} 个问题等待你的回答" if qs else "等待你的回答"
            self._status("waiting_user", status_text)
            fut = app.request_question({"task_id": self.task_id, "call_id": cid, **payload})
            cancel_wait = asyncio.ensure_future(self.cancel.wait())
            try:
                done, _ = await asyncio.wait({fut, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
                if fut not in done:
                    fut.cancel()
                    raise Stopped()
                return list(fut.result())
            finally:
                cancel_wait.cancel()

        tc = ToolContext(ws, Ctx("agent", self.task_id, cid), self.cancel, app.emit, cid, self.read_revisions, app.terminals, ask_question)
        try:
            coro = tool.handler(tc, args)
            result = await asyncio.wait_for(coro, tool.timeout) if tool.timeout and tool.timeout > 0 else await coro
        except WorkspaceError as e:
            card("error", title=title, detail=f"{e.code}: {e.message}")
            return {"error": {"code": e.code, "message": e.message, **e.data}}
        except asyncio.TimeoutError:
            card("error", title=title, detail="已超时")
            return {"error": {"code": "TIMEOUT", "message": f"{name} exceeded {tool.timeout}s"}}
        except Exception as e:
            card("error", title=title, detail=f"{type(e).__name__}: {e}")
            return {"error": {"code": "TOOL_FAILED", "message": f"{type(e).__name__}: {e}"}}

        summary = ""
        if name == "shell_run":
            ok = result["exit_code"] == 0 and not result["timed_out"]
            self.failed_runs += 0 if ok else 1
            summary = "退出码 0" if ok else ("已超时" if result["timed_out"] else f"退出码 {result['exit_code']}")
            ws.checkpoints.add_event(self.task_id, "build_ok" if ok else "build_failed",
                                     f"{'通过' if ok else '失败'}：{args['command'][:80]}",
                                     detail=result["output"][-1500:], exit_code=result["exit_code"],
                                     call_id=cid, tool=name, arguments=args)
        elif name == "fs_read":
            summary = f"{result.get('total_lines', '?')} 行"
            ws.checkpoints.add_event(self.task_id, "read", f"读取 {result['path']}",
                                     call_id=cid, tool=name, arguments=args, path=result["path"])
        elif name in ("fs_list", "fs_search", "fs_glob"):
            n = len(result.get("entries") or result.get("matches") or [])
            summary = f"{n} 条结果"
            ws.checkpoints.add_event(self.task_id, "read", title, call_id=cid, tool=name, arguments=args)
        elif name == "fs_multi_read":
            n = len(result.get("files") or [])
            summary = f"{n} 个文件"
            ws.checkpoints.add_event(self.task_id, "read", title, call_id=cid, tool=name, arguments=args)
        elif name == "web_fetch":
            summary = f"状态码 {result.get('status', '?')}"
            ws.checkpoints.add_event(self.task_id, "read", title, call_id=cid, tool=name, arguments=args)
        elif name == "ask_user":
            pairs = result.get("summary") or []
            summary = "已回答" if len(pairs) <= 1 else f"已回答 {len(pairs)} 个问题"
            text = "\n".join(f'对"{p["question"]}"的回答：{p["answer"]}' for p in pairs) or "已回答"
            self.transcript.append({"role": "user", "text": text, "ts": time.time()})
        card("done", title=title, summary=summary, activity=tool.activity)
        self.transcript.append({"role": "tool", "text": title, "tool": name, "args": args,
                                "state": "done", "summary": summary, "ts": time.time()})
        return result

    async def _ask_user(self, tool, args, title, decision, call_id) -> dict:
        fut = self.app.request_approval({
            "task_id": self.task_id, "call_id": call_id, "tool": tool.id, "title": title, "args": args,
            "risk": tool.risk, "permission_class": tool.permission_class, "reason": decision.reason,
            "forced": decision.source == "hard_policy"})
        cancel_wait = asyncio.ensure_future(self.cancel.wait())
        try:
            done, _ = await asyncio.wait({fut, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
            if fut not in done:
                fut.cancel()
                raise Stopped()
            return fut.result()
        finally:
            cancel_wait.cancel()
