"""Checkpoint store (Time Machine backend). Does not require Git.

Per agent task it keeps:
  * files:  first-touch snapshot of every file the task modified (for "restore to before the task")
  * events: ordered timeline; edit events carry the before-blob so a single tool call can be reverted
Blobs are content-addressed by SHA-256 and shared across tasks.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from pathlib import Path


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def revision_of(data: bytes | None) -> str:
    return "absent" if data is None else "sha256:" + sha256_hex(data)


class CheckpointStore:
    def __init__(self, base_dir: Path):
        self.base = Path(base_dir)
        (self.base / "blobs").mkdir(parents=True, exist_ok=True)
        (self.base / "tasks").mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._tasks: dict[str, dict] = {}

    # ---- blobs -------------------------------------------------------------------------------
    def put_blob(self, data: bytes) -> str:
        sha = sha256_hex(data)
        path = self.base / "blobs" / sha
        if not path.exists():
            tmp = path.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)
        return sha

    def get_blob(self, sha: str) -> bytes:
        return (self.base / "blobs" / sha).read_bytes()

    # ---- tasks -------------------------------------------------------------------------------
    def _path(self, task_id: str) -> Path:
        return self.base / "tasks" / f"{task_id}.json"

    def _save(self, m: dict) -> None:
        tmp = self._path(m["id"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self._path(m["id"]))

    def load(self, task_id: str) -> dict:
        with self._lock:
            if task_id not in self._tasks:
                p = self._path(task_id)
                if not p.exists():
                    raise KeyError(f"unknown task {task_id}")
                self._tasks[task_id] = json.loads(p.read_text(encoding="utf-8"))
            return self._tasks[task_id]

    def start_task(self, goal: str, mode: str = "agent") -> dict:
        with self._lock:
            tid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
            m = {"id": tid, "goal": goal, "mode": mode, "started": time.time(), "ended": None,
                 "status": "running", "files": {}, "events": []}
            self._tasks[tid] = m
            self._save(m)
        self.add_event(tid, "task_started", "任务开始", detail=goal[:300])
        return m

    def finish_task(self, task_id: str, status: str, summary: str = "") -> None:
        with self._lock:
            m = self.load(task_id)
            m["status"], m["ended"] = status, time.time()
            self._save(m)
        self.add_event(task_id, "task_complete" if status == "done" else f"task_{status}",
                       {"done": "任务完成", "incomplete": "任务可能未完成", "stopped": "任务已停止", "error": "任务失败"}.get(status, status),
                       detail=summary[:500])

    def add_event(self, task_id: str, type_: str, title: str, **extra) -> dict:
        with self._lock:
            m = self.load(task_id)
            ev = {"seq": len(m["events"]), "ts": time.time(), "type": type_, "title": title, **extra}
            m["events"].append(ev)
            self._save(m)
            return ev

    def record_before(self, task_id: str, rel: str, data: bytes | None) -> dict:
        """First-touch snapshot: only the earliest state of a file within a task is kept."""
        with self._lock:
            m = self.load(task_id)
            if rel not in m["files"]:
                m["files"][rel] = {"existed": data is not None,
                                   "blob": self.put_blob(data) if data is not None else None}
                self._save(m)
            return m["files"][rel]

    def blob_for_event_before(self, data: bytes | None) -> str | None:
        return self.put_blob(data) if data is not None else None

    def mark_reverted(self, task_id: str, seqs: list[int]) -> None:
        with self._lock:
            m = self.load(task_id)
            for s in seqs:
                if 0 <= s < len(m["events"]):
                    m["events"][s]["reverted"] = True
            self._save(m)

    def list_tasks(self, limit: int = 50) -> list[dict]:
        out = []
        for p in sorted((self.base / "tasks").glob("*.json"), reverse=True)[:limit]:
            try:
                m = self.load(p.stem)
            except Exception:
                continue
            out.append({"id": m["id"], "goal": m["goal"], "status": m["status"], "started": m["started"],
                        "ended": m["ended"], "files": list(m["files"].keys()), "events": len(m["events"])})
        return out
