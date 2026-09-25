"""Provider profiles. The frontend only ever sees profile ids and `has_key`; keys never leave the Bridge."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from .openai_compat import PRESETS

_ID = re.compile(r"^[A-Za-z0-9._-]{1,48}$")
_FIELDS = ("id", "name", "kind", "endpoint", "model", "headers", "tool_calling", "sampling", "extra_body")


def _atomic_json(path: Path, obj, mode: int | None = None) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    if mode is not None:
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
    os.replace(tmp, path)


class ProfileStore:
    def __init__(self, data_dir: Path):
        self.pf = data_dir / "profiles.json"
        self.sf = data_dir / "secrets.json"
        self._lock = threading.Lock()

    def _load(self, path: Path, default):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def list_public(self) -> list[dict]:
        secrets = self._load(self.sf, {})
        return [{**p, "has_key": bool(secrets.get(p["id"]))} for p in self._load(self.pf, [])]

    def get(self, profile_id: str) -> tuple[dict, str | None]:
        for p in self._load(self.pf, []):
            if p["id"] == profile_id:
                return p, self._load(self.sf, {}).get(profile_id)
        raise KeyError(f"no provider profile '{profile_id}'")

    def save(self, profile: dict, api_key: str | None = None) -> dict:
        prof = {k: profile[k] for k in _FIELDS if k in profile}
        if not _ID.match(str(prof.get("id", ""))):
            raise ValueError("配置编号需为 1 到 48 个字符，只能包含字母、数字以及 . _ -")
        kind = prof.get("kind", "openai_compatible")
        preset = PRESETS.get(kind, {})
        prof.setdefault("kind", kind)
        prof.setdefault("name", prof["id"])
        prof["endpoint"] = prof.get("endpoint") or preset.get("endpoint", "")
        prof["model"] = prof.get("model") or preset.get("model", "")
        prof.setdefault("tool_calling", True)
        with self._lock:
            profiles = [p for p in self._load(self.pf, []) if p["id"] != prof["id"]]
            profiles.append(prof)
            _atomic_json(self.pf, profiles)
            if api_key is not None:
                secrets = self._load(self.sf, {})
                if api_key == "":
                    secrets.pop(prof["id"], None)
                else:
                    secrets[prof["id"]] = api_key
                _atomic_json(self.sf, secrets, 0o600)
        return {**prof, "has_key": bool(api_key) or bool(self._load(self.sf, {}).get(prof["id"]))}

    def delete(self, profile_id: str) -> None:
        with self._lock:
            _atomic_json(self.pf, [p for p in self._load(self.pf, []) if p["id"] != profile_id])
            secrets = self._load(self.sf, {})
            if secrets.pop(profile_id, None) is not None:
                _atomic_json(self.sf, secrets, 0o600)
