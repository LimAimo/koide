"""Hard Policy: deterministic rules that outrank the main agent, the Approval Agent and user profiles.

A verdict of "deny" can never be overridden. A verdict of "ask" forces a human confirmation even if
an Approval Agent said ALLOW or the tool is set to "Always Allow".
"""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from pathlib import Path

WRITE_OPS = {"write", "delete", "rename", "create", "patch"}

_SENSITIVE_DIRS = {".ssh", ".gnupg", ".aws", ".kube", ".docker"}
_SENSITIVE_FILES = {"id_rsa", "id_ed25519", "id_ecdsa", ".netrc", ".pgpass", "credentials", "shadow"}
_SYSTEM_PREFIXES = ("/etc", "/usr", "/bin", "/sbin", "/boot", "/sys", "/proc", "/dev", "/lib", "/var/lib")

_DENY_COMMANDS = [
    (r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(/|~|\$HOME|/\*|~/\*)(\s|$)",
     "递归删除系统根目录或用户主目录"),
    (r"\bmkfs(\.\w+)?\b", "格式化文件系统"),
    (r"\bdd\b[^|;]*\bof=/dev/", "向设备写入原始数据"),
    (r":\(\)\s*\{.*\};\s*:", "fork 炸弹"),
    (r">\s*/dev/(sd|nvme|mmcblk)", "覆盖块设备"),
    (r"\bchmod\s+-R\s+[0-7]{3,4}\s+/(\s|$)", "对根目录递归修改权限"),
]
_ASK_COMMANDS = [
    (r"\bsudo\b|\bsu\s+-?\w*", "提升权限"),
    (r"(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b", "把下载内容直接交给 shell 执行"),
    (r"\bgit\s+reset\s+--hard\b", "git reset --hard 会丢弃未提交的工作"),
    (r"\bgit\s+push\b[^;|&]*(--force\b|--force-with-lease\b|\s-f\b)", "强制推送会改写远程历史"),
    (r"\bgit\s+clean\s+-[a-zA-Z]*f", "git clean 会删除未跟踪的文件"),
    (r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r", "递归删除"),
    (r"\b(shutdown|reboot|halt|poweroff)\b", "关机或重启"),
    (r"\b(pkill|killall)\b", "按名称结束进程"),
]


@dataclass
class Verdict:
    action: str  # "deny" | "ask"
    reason: str


class HardPolicy:
    def __init__(self, bridge_dir: Path, data_dir: Path, allow_self_modify: bool = False):
        self.bridge_dir = bridge_dir.resolve()
        self.data_dir = data_dir.resolve()
        self.allow_self_modify = allow_self_modify

    @staticmethod
    def _inside(path: Path, root: Path) -> bool:
        return path == root or root in path.parents

    def check_path(self, path: Path, op: str) -> Verdict | None:
        p = path.resolve()
        if self._inside(p, self.data_dir):
            return Verdict("deny", "Diffusion 自己的数据目录（密钥、检查点）禁止访问")
        if self._inside(p, self.bridge_dir) and op in WRITE_OPS:
            if not self.allow_self_modify:
                return Verdict("deny", "智能体不得修改正在运行的桥接服务（自我保护）")
            return Verdict("ask", "修改正在运行的桥接服务可能会弄坏工具环境")
        parts = {x.lower() for x in p.parts}
        if parts & _SENSITIVE_DIRS or p.name.lower() in _SENSITIVE_FILES:
            return Verdict("ask", "该路径存放凭据或密钥")
        if p.name == ".env" or p.name.startswith(".env."):
            return Verdict("ask", "环境变量文件可能包含机密信息")
        posix = p.as_posix()
        if op in WRITE_OPS and any(posix == s or posix.startswith(s + "/") for s in _SYSTEM_PREFIXES):
            return Verdict("deny", "禁止写入系统目录")
        return None

    def check_command(self, command: str) -> Verdict | None:
        for pattern, why in _DENY_COMMANDS:
            if re.search(pattern, command):
                return Verdict("deny", f"已拦截的命令：{why}")
        for pattern, why in _ASK_COMMANDS:
            if re.search(pattern, command):
                return Verdict("ask", f"高风险命令：{why}")
        try:
            tokens = shlex.split(command, posix=True)
        except ValueError:
            tokens = command.split()
        for tok in tokens:
            if tok.startswith(("/", "~", ".")) and len(tok) > 1:
                try:
                    tp = Path(tok).expanduser().resolve()
                except (OSError, RuntimeError):
                    continue
                if self._inside(tp, self.data_dir):
                    return Verdict("deny", "命令涉及 Diffusion 的私有数据目录")
                if self._inside(tp, self.bridge_dir) and not self.allow_self_modify:
                    return Verdict("ask", "命令涉及正在运行的桥接服务")
        return None

    def check_tool_call(self, tool_id: str, permission_class: str, args: dict, workspace=None) -> Verdict | None:
        """Path-bearing args are checked here; workspace-boundary checks live in Workspace.resolve."""
        op = {"write": "write", "delete": "delete"}.get(permission_class, "read")
        for key in ("path", "src", "dst", "from", "to"):
            val = args.get(key)
            if isinstance(val, str) and workspace is not None:
                try:
                    v = self.check_path(workspace.resolve(val, check_policy=False), op)
                except Exception:
                    continue  # boundary errors are raised later with a clearer message
                if v:
                    return v
        if permission_class == "exec" and isinstance(args.get("command"), str):
            return self.check_command(args["command"])
        return None
