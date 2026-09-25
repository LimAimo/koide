"""Polling file watcher: portable, dependency-free, and cheap enough for phones."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Callable

from .workspace import SKIP_IN_SEARCH, TMP_PREFIX

MAX_ENTRIES = 20_000


def snapshot(root: Path) -> dict[str, tuple[int, int]]:
    snap: dict[str, tuple[int, int]] = {}
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_IN_SEARCH]
        for fn in files:
            if fn.startswith(TMP_PREFIX):
                continue
            fp = Path(dirpath) / fn
            try:
                st = fp.stat()
            except OSError:
                continue
            snap[fp.relative_to(root).as_posix()] = (st.st_mtime_ns, st.st_size)
            if len(snap) >= MAX_ENTRIES:
                return snap
    return snap


def diff(old: dict, new: dict) -> list[tuple[str, str]]:
    out = [(p, "create") for p in new.keys() - old.keys()]
    out += [(p, "delete") for p in old.keys() - new.keys()]
    out += [(p, "modify") for p in new.keys() & old.keys() if new[p] != old[p]]
    return sorted(out)


async def watch(root: Path, on_changes: Callable[[list[tuple[str, str]]], None], interval: float = 1.5):
    last = await asyncio.to_thread(snapshot, root)
    while True:
        await asyncio.sleep(interval)
        cur = await asyncio.to_thread(snapshot, root)
        changes = diff(last, cur)
        last = cur
        if changes:
            on_changes(changes[:500])
