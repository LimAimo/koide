"""Git 操作：全部通过系统里的 git 命令完成，不引入任何第三方库。

不提供强制推送。Git 回退由 Bridge 做显式确认；“强制回退”文件恢复仍经过 Workspace / 回收站。
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


class GitError(Exception):
    pass


_FRIENDLY = [
    ("not a git repository", "这个文件夹还不是 Git 仓库"),
    ("Please tell me who you are", "请先配置 git 的用户名和邮箱：git config user.name / git config user.email"),
    ("nothing to commit", "没有可提交的改动"),
    ("no changes added to commit", "没有已暂存的改动可提交"),
    ("could not read Username", "需要账号密码才能访问远程仓库，请先在终端里配置凭据"),
    ("Authentication failed", "远程仓库认证失败"),
    ("non-fast-forward", "远程有新的提交，请先拉取"),
    ("Not possible to fast-forward", "无法快进合并，请在终端里手动处理"),
    ("has no upstream branch", "当前分支还没有关联远程分支"),
    ("already exists", "该分支已存在"),
    ("did not match any", "找不到这个分支或路径"),
]


def _run(root: Path, args: list[str], timeout: float = 30, check: bool = True) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "GIT_PAGER": "cat"}
    try:
        r = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=str(root), capture_output=True, timeout=timeout, env=env)
    except FileNotFoundError:
        raise GitError("没有找到 git 命令，请先安装 git")
    except subprocess.TimeoutExpired:
        raise GitError("git 命令超时")
    out, err = r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
    if check and r.returncode != 0:
        text = (err or out).strip()
        for key, zh in _FRIENDLY:
            if key in text:
                raise GitError(zh)
        raise GitError(text[:400] or f"git 退出码 {r.returncode}")
    return out


def _run_bytes(root: Path, args: list[str], timeout: float = 30, check: bool = True) -> bytes:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "GIT_PAGER": "cat"}
    try:
        r = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=str(root), capture_output=True, timeout=timeout, env=env)
    except FileNotFoundError:
        raise GitError("没有找到 git 命令，请先安装 git")
    except subprocess.TimeoutExpired:
        raise GitError("git 命令超时")
    if check and r.returncode != 0:
        text = (r.stderr or r.stdout).decode("utf-8", "replace").strip()
        raise GitError(text[:400] or f"git 退出码 {r.returncode}")
    return r.stdout


def resolve_commit(root: Path, ref: str) -> str:
    if not ref or ref.startswith("-"):
        raise GitError("提交版本无效")
    return _run(root, ["rev-parse", "--verify", f"{ref}^{{commit}}"]).strip()


def reset_soft(root: Path, ref: str) -> str:
    commit = resolve_commit(root, ref)
    _run(root, ["reset", "--soft", commit])
    return commit


def reset_mixed(root: Path, ref: str) -> str:
    commit = resolve_commit(root, ref)
    _run(root, ["reset", "--mixed", commit])
    return commit


def tracked_modes(root: Path) -> dict[str, str]:
    raw = _run_bytes(root, ["ls-files", "-s", "-z"], check=False)
    out = {}
    for row in raw.split(b"\0"):
        if not row or b"\t" not in row:
            continue
        meta, path = row.split(b"\t", 1)
        parts = meta.split()
        if parts:
            out[path.decode("utf-8", "replace")] = parts[0].decode()
    return out


def tree(root: Path, ref: str) -> dict[str, dict]:
    commit = resolve_commit(root, ref)
    raw = _run_bytes(root, ["ls-tree", "-r", "-z", commit])
    out = {}
    for row in raw.split(b"\0"):
        if not row or b"\t" not in row:
            continue
        meta, path = row.split(b"\t", 1)
        parts = meta.split()
        if len(parts) == 3:
            out[path.decode("utf-8", "replace")] = {"mode": parts[0].decode(), "type": parts[1].decode(), "sha": parts[2].decode()}
    return out


def blob(root: Path, sha: str) -> bytes:
    return _run_bytes(root, ["cat-file", "blob", sha])


def is_repo(root: Path) -> bool:
    try:
        return _run(root, ["rev-parse", "--is-inside-work-tree"], check=False).strip() == "true"
    except GitError:
        return False


def status(root: Path) -> dict:
    if not is_repo(root):
        return {"is_repo": False}
    out = _run(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"])
    info = {"is_repo": True, "branch": "", "upstream": None, "ahead": 0, "behind": 0, "files": []}
    for line in out.split("\n"):
        if not line:
            continue
        if line.startswith("## "):
            head = line[3:]
            if head.startswith("No commits yet on "):
                info["branch"] = head[len("No commits yet on "):]
            elif head.startswith("HEAD (no branch)"):
                info["branch"] = "（游离 HEAD）"
            else:
                name, _, rest = head.partition("...")
                info["branch"] = name
                if rest:
                    up, _, tail = rest.partition(" [")
                    info["upstream"] = up
                    for part in tail.rstrip("]").split(", "):
                        if part.startswith("ahead "):
                            info["ahead"] = int(part[6:])
                        elif part.startswith("behind "):
                            info["behind"] = int(part[7:])
            continue
        x, y, path = line[0], line[1], line[3:]
        orig = None
        if " -> " in path and x in "RC":
            orig, path = path.split(" -> ", 1)
        info["files"].append({"path": path, "index": x, "worktree": y, "orig": orig})
    return info


def diff(root: Path, path: str, staged: bool = False) -> str:
    st = status(root)
    entry = next((f for f in st.get("files", []) if f["path"] == path), None)
    if entry and entry["index"] == "?" and not staged:            # 未跟踪的新文件：显示为全部新增
        try:
            text = (root / path).read_text("utf-8", "replace")
        except OSError as e:
            raise GitError(str(e))
        body = "".join(f"+{ln}\n" for ln in text.split("\n")[:2000])
        return f"新文件 {path}\n@@ -0,0 +1,{text.count(chr(10)) + 1} @@\n{body}"
    args = ["diff", "--no-color"] + (["--cached"] if staged else []) + ["--", path]
    return _run(root, args)[:200_000]


def stage(root: Path, paths: list[str]) -> None:
    _run(root, ["add", "--", *paths])


def unstage(root: Path, paths: list[str]) -> None:
    try:
        _run(root, ["restore", "--staged", "--", *paths])
    except GitError:
        _run(root, ["rm", "--cached", "-r", "-q", "--", *paths])


def discard_tracked(root: Path, path: str) -> None:
    _run(root, ["restore", "--", path])


def commit(root: Path, message: str) -> str:
    if not message.strip():
        raise GitError("提交说明不能为空")
    _run(root, ["commit", "-m", message.strip()])
    return _run(root, ["rev-parse", "--short", "HEAD"]).strip()


def branches(root: Path) -> list[dict]:
    out = _run(root, ["branch", "--format=%(refname:short)\t%(HEAD)"], check=False)
    return [{"name": n, "current": h.strip() == "*"} for n, _, h in (l.partition("\t") for l in out.split("\n") if l)]


def checkout(root: Path, name: str, create: bool = False) -> None:
    if name.startswith("-") or not name.strip():
        raise GitError("分支名无效")
    _run(root, ["switch"] + (["-c"] if create else []) + [name])


def log(root: Path, limit: int = 50, path: str | None = None) -> list[dict]:
    args = ["log", f"-n{int(limit)}", "--date=relative", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s"]
    if path:
        args += ["--", path]
    out = _run(root, args, check=False)
    rows = []
    for line in out.split("\n"):
        parts = line.split("\x1f")
        if len(parts) == 4:
            rows.append({"hash": parts[0], "author": parts[1], "date": parts[2], "subject": parts[3]})
    return rows


def blame(root: Path, path: str) -> list[dict]:
    out = _run(root, ["blame", "--line-porcelain", "--", path])
    rows, cur = [], {}
    for line in out.split("\n"):
        if line.startswith("\t"):
            rows.append({"hash": cur.get("hash", "")[:7], "author": cur.get("author", "")})
            cur = {}
        elif line.startswith("author "):
            cur["author"] = line[7:]
        elif len(line) > 40 and line[40:41] == " " and all(c in "0123456789abcdef" for c in line[:40]):
            cur["hash"] = line[:40]
    return rows


def pull(root: Path) -> str:
    return _run(root, ["pull", "--ff-only"], timeout=90).strip()


def push(root: Path) -> str:
    return (_run(root, ["push"], timeout=90) or "已推送").strip()


def init(root: Path) -> None:
    _run(root, ["init"])
