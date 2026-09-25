"""Run shell commands (Termux / Linux / macOS / Windows) with streaming output and safe termination."""
from __future__ import annotations

import asyncio
import os
import shutil
import signal
from typing import Awaitable, Callable

MAX_CAPTURE = 60_000   # characters kept for the model; the UI still receives the full stream


def shell_argv(command: str) -> list[str]:
    if os.name == "nt":
        ps = shutil.which("pwsh") or shutil.which("powershell")
        return [ps, "-NoProfile", "-Command", command] if ps else ["cmd.exe", "/c", command]
    # Termux has no /bin/sh, so resolve from PATH
    sh = shutil.which("bash") or shutil.which("sh") or "/bin/sh"
    return [sh, "-c", command]


def _kill_tree(proc: asyncio.subprocess.Process, sig=signal.SIGTERM) -> None:
    try:
        if os.name == "posix":
            os.killpg(proc.pid, sig)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError):
        pass


async def run_shell(command: str, cwd: str, timeout: float, cancel: asyncio.Event | None,
                    on_output: Callable[[str, str], None] | None = None,
                    env: dict | None = None) -> dict:
    """Returns {exit_code, output, timed_out, cancelled, pid}. Never raises for non-zero exits."""
    proc = await asyncio.create_subprocess_exec(
        *shell_argv(command), cwd=cwd, env={**os.environ, **(env or {})},
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=(os.name == "posix"))
    chunks: list[str] = []
    total = 0

    async def pump():
        nonlocal total
        assert proc.stdout
        while True:
            data = await proc.stdout.read(4096)
            if not data:
                return
            text = data.decode("utf-8", "replace")
            if on_output:
                on_output("stdout", text)
            if total < MAX_CAPTURE:
                chunks.append(text)
                total += len(text)

    pump_task = asyncio.create_task(pump())
    waiters = {asyncio.create_task(proc.wait())}
    cancel_task = asyncio.create_task(cancel.wait()) if cancel else None
    if cancel_task:
        waiters.add(cancel_task)
    timed_out = cancelled = False
    try:
        done, _ = await asyncio.wait(waiters, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if not done:
            timed_out = True
        elif cancel_task and cancel_task in done and proc.returncode is None:
            cancelled = True
        if proc.returncode is None:
            _kill_tree(proc)
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except asyncio.TimeoutError:
                _kill_tree(proc, signal.SIGKILL if os.name == "posix" else signal.SIGTERM)
                await proc.wait()
        await asyncio.wait_for(pump_task, 3)
    except asyncio.TimeoutError:
        pass
    finally:
        for t in waiters:
            t.cancel()
        pump_task.cancel()
    out = "".join(chunks)
    if total >= MAX_CAPTURE:
        out += "\n[输出已截断]"
    return {"exit_code": proc.returncode, "output": out, "timed_out": timed_out, "cancelled": cancelled}
