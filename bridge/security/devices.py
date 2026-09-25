"""Paired devices for LAN Mode. Tokens are random, stored only as SHA-256, revocable, and expire."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path

CODE_TTL = 300                    # seconds a pairing code stays valid
TOKEN_TTL = 30 * 24 * 3600        # default device token lifetime


class DeviceStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._code: tuple[str, float] | None = None
        self._attempts = 0

    def _load(self) -> list[dict]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []

    def _save(self, items: list[dict]) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, indent=1), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    def new_code(self) -> str:
        with self._lock:
            code = f"{secrets.randbelow(10**6):06d}"
            self._code, self._attempts = (code, time.time() + CODE_TTL), 0
            return code

    def pair(self, code: str, name: str, ttl: int = TOKEN_TTL) -> str | None:
        with self._lock:
            if not self._code or time.time() > self._code[1] or self._attempts >= 5:
                self._code = None
                return None
            self._attempts += 1
            if not secrets.compare_digest(code or "", self._code[0]):
                return None
            self._code = None          # single use
            token = secrets.token_urlsafe(32)
            items = self._load()
            items.append({"id": secrets.token_hex(4), "name": (name or "device")[:60],
                          "hash": hashlib.sha256(token.encode()).hexdigest(),
                          "created": time.time(), "expires": time.time() + ttl, "last_seen": time.time()})
            self._save(items)
            return token

    def verify(self, token: str | None) -> dict | None:
        if not token:
            return None
        h = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            for d in self._load():
                if secrets.compare_digest(d["hash"], h) and d["expires"] > time.time():
                    return d
        return None

    def list(self) -> list[dict]:
        return [{k: v for k, v in d.items() if k != "hash"} for d in self._load()]

    def revoke(self, device_id: str) -> bool:
        with self._lock:
            items = self._load()
            keep = [d for d in items if d["id"] != device_id]
            self._save(keep)
            return len(keep) != len(items)
