"""真正的伪终端（PTY）会话：可以运行交互式 shell、长时间运行的进程，并支持调整窗口大小。

只在 Linux / macOS / Termux 上可用（需要标准库 pty）。Windows 上会抛出 PtyUnavailable，界面改用一次性命令。
"""
from __future__ import annotations

import asyncio
import codecs
import os
import shutil
import signal
import struct
import subprocess
import threading

try:
    import fcntl
    import pty
    import termios
    HAVE_PTY = True
except ImportError:          # Windows
    HAVE_PTY = False

RING = 64_000


class PtyUnavailable(Exception):
    pass


def _winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class PtySession:
    def __init__(self, sid: str, cwd: str, cols: int, rows: int, on_data, on_exit):
        if not HAVE_PTY:
            raise PtyUnavailable("这个系统不支持交互式终端")
        self.sid, self.on_data, self.on_exit = sid, on_data, on_exit
        self.ring = ""
        self.alive = True
        self._dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        master, slave = pty.openpty()
        _winsize(master, rows, cols)
        shell = os.environ.get("SHELL") or shutil.which("bash") or shutil.which("sh") or "/bin/sh"
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}

        def child_setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen([shell], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
                                     preexec_fn=child_setup, close_fds=True)
        os.close(slave)
        self.master = master
        self.loop = asyncio.get_running_loop()
        self.loop.add_reader(master, self._readable)
        self.shell = os.path.basename(shell)

    @property
    def pid(self) -> int:
        return self.proc.pid

    def _readable(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except OSError:
            data = b""
        if not data:
            self._finish()
            return
        text = self._dec.decode(data)
        if text:
            self.ring = (self.ring + text)[-RING:]
            self.on_data(self.sid, text)

    def _finish(self) -> None:
        if not self.alive:
            return
        self.alive = False
        try:
            self.loop.remove_reader(self.master)
        except Exception:
            pass

        def wait():
            try:
                code = self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._kill(signal.SIGKILL)
                code = self.proc.wait()
            try:
                os.close(self.master)
            except OSError:
                pass
            self.loop.call_soon_threadsafe(self.on_exit, self.sid, code)
        threading.Thread(target=wait, daemon=True).start()

    def write(self, text: str) -> None:
        if self.alive:
            os.write(self.master, text.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        if self.alive:
            _winsize(self.master, max(2, rows), max(2, cols))

    def _kill(self, sig) -> None:
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def close(self) -> None:
        if self.alive:
            self._kill(signal.SIGHUP)
            self.loop.call_later(1.0, lambda: self.proc.poll() is None and self._kill(signal.SIGKILL))
            self._finish()


def listening_ports() -> list[dict]:
    """列出本机正在监听的 TCP 端口（Linux 读 /proc，其他系统尝试 lsof）。"""
    ports: dict[int, str] = {}
    for f, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
        try:
            with open(f) as fh:
                next(fh)
                for line in fh:
                    cols = line.split()
                    if len(cols) > 3 and cols[3] == "0A":
                        addr, port = cols[1].rsplit(":", 1)
                        ports[int(port, 16)] = "IPv6" if v6 else "IPv4"
        except (OSError, StopIteration):
            continue
    if not ports and shutil.which("lsof"):
        try:
            out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], capture_output=True, timeout=5).stdout.decode()
            for line in out.split("\n"):
                if line.startswith("n") and ":" in line:
                    try:
                        ports[int(line.rsplit(":", 1)[1])] = "TCP"
                    except ValueError:
                        pass
        except Exception:
            pass
    return [{"port": p, "family": ports[p]} for p in sorted(ports)]
