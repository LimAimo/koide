"""Diffusion Trash. Deleting never destroys data immediately, for humans or agents alike."""
from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path


class TrashError(Exception):
    pass


class Trash:
    def __init__(self, base_dir: Path):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)

    def move_in(self, abs_path: Path) -> str:
        tid = time.strftime("%Y%m%d%H%M%S-") + uuid.uuid4().hex[:6]
        slot = self.base / tid
        slot.mkdir()
        is_dir = abs_path.is_dir()
        size = 0 if is_dir else abs_path.stat().st_size
        shutil.move(str(abs_path), str(slot / "payload"))
        (slot / "meta.json").write_text(json.dumps({
            "id": tid, "original": str(abs_path), "deleted_at": time.time(), "is_dir": is_dir, "size": size,
        }), encoding="utf-8")
        return tid

    def list(self) -> list[dict]:
        items = []
        for meta in sorted(self.base.glob("*/meta.json"), reverse=True):
            try:
                items.append(json.loads(meta.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return items

    def _slot(self, tid: str) -> Path:
        if not tid or "/" in tid or "\\" in tid or tid.startswith("."):
            raise TrashError("回收站编号无效")
        slot = self.base / tid
        if not (slot / "meta.json").exists():
            raise TrashError("回收站里没有这一项")
        return slot

    def restore(self, tid: str) -> Path:
        slot = self._slot(tid)
        meta = json.loads((slot / "meta.json").read_text(encoding="utf-8"))
        dest = Path(meta["original"])
        if dest.exists():
            raise TrashError(f"无法恢复：{dest.name} 已经存在")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(slot / "payload"), str(dest))
        shutil.rmtree(slot, ignore_errors=True)
        return dest

    def delete_permanently(self, tid: str) -> None:
        shutil.rmtree(self._slot(tid), ignore_errors=True)

    def empty(self) -> int:
        n = 0
        for meta in list(self.base.glob("*/meta.json")):
            shutil.rmtree(meta.parent, ignore_errors=True)
            n += 1
        return n
