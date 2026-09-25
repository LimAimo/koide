"""Approval Agent. It can only advise; the deterministic Hard Policy is applied before and above it."""
from __future__ import annotations

import asyncio
import json
import platform
import re

SYSTEM = (
    "You are the approval reviewer for an AI coding agent working in a user's local project. "
    "Judge exactly ONE tool call. Reply with ONLY compact JSON: "
    '{"decision":"ALLOW"|"ASK_USER"|"DENY","reason":"<one short sentence>"}. '
    "ALLOW only if the call clearly serves the stated task, stays inside the workspace and is easy to undo. "
    "ASK_USER if unsure, destructive, irreversible, touching credentials, or installing/downloading software. "
    "DENY if it is clearly malicious, unrelated to the task, or tries to weaken safety controls."
)


def parse_verdict(text: str) -> tuple[str, str]:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return "ASK_USER", "审批模型没有给出结论"
    try:
        obj = json.loads(m.group(0))
    except ValueError:
        return "ASK_USER", "审批模型的结论不是有效的 JSON"
    decision = str(obj.get("decision", "")).upper()
    if decision not in ("ALLOW", "ASK_USER", "DENY"):
        return "ASK_USER", "审批模型的结论无法识别"
    return decision, str(obj.get("reason", ""))[:300]


async def git_status(cwd: str) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "status", "--short", "--branch", cwd=cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), 3)
        return out.decode("utf-8", "replace")[:800]
    except Exception:
        return "(not a git repository or git unavailable)"


def make_reviewer(provider, profile: dict, api_key: str | None, workspace, goal: str, permission_cfg: dict,
                  last_reason: callable):
    async def review(payload: dict) -> tuple[str, str]:
        ctx = {
            "requested_tool": payload["tool"]["id"], "risk_level": payload["tool"]["risk"],
            "permission_class": payload["tool"]["permission_class"], "arguments": payload["arguments"],
            "workspace": str(workspace.primary), "os": platform.platform(),
            "current_task": goal, "agent_reason": last_reason(),
            "git_status": await git_status(str(workspace.primary)), "permission_config": permission_cfg,
        }
        text = await asyncio.wait_for(provider.complete(
            profile, api_key,
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(ctx, indent=1)}]), 60)
        return parse_verdict(text)
    return review
