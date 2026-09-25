"""终端会话管理：最多同时 8 个 PTY 会话；会话输出保留在环形缓冲里，方便重新连接和让智能体读取。"""
from __future__ import annotations

import uuid

from .pty_session import PtySession

MAX_SESSIONS = 8


class TerminalManager:
    def __init__(self, emit):
        self.emit = emit
        self.sessions: dict[str, PtySession] = {}
        self.last: str | None = None

    def open(self, cwd: str, cols: int, rows: int) -> PtySession:
        alive = [s for s in self.sessions.values() if s.alive]
        if len(alive) >= MAX_SESSIONS:
            raise RuntimeError(f"最多同时打开 {MAX_SESSIONS} 个终端")
        sid = uuid.uuid4().hex[:6]
        s = PtySession(sid, cwd, cols, rows, self._data, self._exit)
        self.sessions[sid] = s
        self.last = sid
        return s

    def _data(self, sid: str, text: str) -> None:
        self.emit("terminal.data", {"id": sid, "data": text})

    def _exit(self, sid: str, code) -> None:
        self.emit("terminal.closed", {"id": sid, "exit_code": code})

    def get(self, sid: str | None = None) -> PtySession | None:
        return self.sessions.get(sid or self.last or "")

    def list(self) -> list[dict]:
        return [{"id": s.sid, "pid": s.pid, "alive": s.alive, "shell": s.shell} for s in self.sessions.values()]

    def close(self, sid: str) -> None:
        s = self.sessions.get(sid)
        if s:
            s.close()

    def close_all(self) -> None:
        for s in list(self.sessions.values()):
            s.close()
