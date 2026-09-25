"""Permission engine.

Evaluation order (first match wins):
  1. Hard Policy "deny"                       -> DENY   (nothing can override)
  2. per-tool setting "deny"                  -> DENY
  3. Hard Policy "ask"                        -> ASK    (even Autonomous / Always Allow / Approval Agent ALLOW)
  4. per-tool setting "ask"                   -> ASK
  5. read-class tools inside the workspace    -> ALLOW
  6. per-tool "always"/session grant          -> ALLOW
  7. mode: restricted -> ASK | manual -> ASK | autonomous -> ALLOW unless risk high | ai -> Approval Agent
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from typing import Awaitable, Callable

MODES = ("restricted", "manual", "ai", "autonomous")
TOOL_SETTINGS = ("deny", "ask", "session", "always", "ai_review")


@dataclass
class Decision:
    action: str      # allow | ask | deny
    reason: str = ""
    source: str = "mode"


Reviewer = Callable[[dict], Awaitable[tuple[str, str]]]   # -> ("ALLOW"|"ASK_USER"|"DENY", reason)


class PermissionEngine:
    def __init__(self, policy, mode: str = "manual", tool_settings: dict | None = None, tool_rules: dict | None = None):
        self.policy = policy
        self.tool_rules: dict[str, dict] = dict(tool_rules or {})
        self.mode = mode if mode in MODES else "manual"
        self.tool_settings: dict[str, str] = dict(tool_settings or {})
        self.session_grants: set[str] = set()

    def config(self) -> dict:
        return {"mode": self.mode, "tool_settings": self.tool_settings, "tool_rules": self.tool_rules}

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"未知的模式：{mode}")
        self.mode = mode

    def set_tool(self, tool_id: str, setting: str | None) -> None:
        if setting is None:
            self.tool_settings.pop(tool_id, None)
        elif setting in TOOL_SETTINGS:
            self.tool_settings[tool_id] = setting
        else:
            raise ValueError(f"未知的设置：{setting}")

    def set_rules(self, tool_id: str, rules: dict | None) -> None:
        """按路径或命令的通配符规则：deny 命中即拒绝，allow 命中即自动允许。"""
        clean = {k: [str(x).strip() for x in (rules or {}).get(k, []) if str(x).strip()] for k in ("allow", "deny")}
        if clean["allow"] or clean["deny"]:
            self.tool_rules[tool_id] = clean
        else:
            self.tool_rules.pop(tool_id, None)

    @staticmethod
    def _target(tool, args: dict) -> str:
        if tool.id == "shell_run":
            return str(args.get("command", ""))
        return str(args.get("path") or args.get("from") or "")

    def _rule_hit(self, tool, args: dict, kind: str) -> str | None:
        target = self._target(tool, args)
        for pat in self.tool_rules.get(tool.id, {}).get(kind, []):
            if target and (fnmatch.fnmatchcase(target, pat) or fnmatch.fnmatchcase(target.lstrip("./"), pat)):
                return pat
        return None

    def grant_session(self, tool_id: str) -> None:
        self.session_grants.add(tool_id)

    async def evaluate(self, tool, args: dict, workspace, reviewer: Reviewer | None = None,
                       review_context: dict | None = None) -> Decision:
        hard = self.policy.check_tool_call(tool.id, tool.permission_class, args, workspace)
        if hard and hard.action == "deny":
            return Decision("deny", hard.reason, "hard_policy")
        setting = self.tool_settings.get(tool.id)
        if setting == "deny":
            return Decision("deny", f"设置中已禁用 {tool.id}", "setting")
        hit = self._rule_hit(tool, args, "deny")
        if hit:
            return Decision("deny", f"命中了你设置的禁止规则：{hit}", "rule")
        if hard and hard.action == "ask":
            return Decision("ask", hard.reason, "hard_policy")
        if setting == "ask":
            return Decision("ask", f"设置中要求每次都询问 {tool.id}", "setting")
        hit = self._rule_hit(tool, args, "allow")
        if hit:
            return Decision("allow", f"命中了你设置的自动允许规则：{hit}", "rule")
        if tool.permission_class in ("read", "interaction"):
            return Decision("allow", "读取工作区内的文件" if tool.permission_class == "read" else "向用户提问", "mode")
        if setting == "always" or tool.id in self.session_grants:
            return Decision("allow", "你的设置已允许", "setting")
        if setting == "ai_review" or self.mode == "ai":
            if reviewer is None:
                return Decision("ask", "没有可用的审批模型", "approval_agent")
            try:
                verdict, why = await reviewer({"tool": tool.describe(), "arguments": args,
                                               **(review_context or {})})
            except Exception as e:  # any failure of the reviewer fails safe
                return Decision("ask", f"审批模型出错（{e}）", "approval_agent")
            if verdict == "ALLOW":
                return Decision("allow", why or "审批模型已批准", "approval_agent")
            if verdict == "DENY":
                return Decision("deny", why or "审批模型已拒绝", "approval_agent")
            return Decision("ask", why or "审批模型建议由你确认", "approval_agent")
        if self.mode == "autonomous":
            if tool.risk == "high":
                return Decision("ask", "高风险操作", "mode")
            return Decision("allow", "自主模式", "mode")
        return Decision("ask", "需要你确认", "mode")
