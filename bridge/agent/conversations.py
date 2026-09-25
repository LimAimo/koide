"""会话历史：每个工作区可以有多个会话，每个会话保存对话和工具活动，后续任务可以带着上下文继续。"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path


class ConversationStore:
    def __init__(self, base: Path):
        self.base = Path(base)
        self.base.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, cid: str) -> Path:
        if not cid or "/" in cid or "\\" in cid or cid.startswith("."):
            raise KeyError("会话编号无效")
        return self.base / f"{cid}.json"

    def _save(self, conv: dict) -> None:
        tmp = self._path(conv["id"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(conv, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path(conv["id"]))

    def create(self, title: str) -> dict:
        conv = {"id": time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4], "title": (title or "新对话").strip()[:60],
                "created": time.time(), "updated": time.time(), "entries": []}
        with self._lock:
            self._save(conv)
        return conv

    def get(self, cid: str) -> dict:
        try:
            return json.loads(self._path(cid).read_text(encoding="utf-8"))
        except OSError:
            raise KeyError("找不到这个会话")

    def append(self, cid: str, entries: list[dict]) -> None:
        with self._lock:
            conv = self.get(cid)
            conv["entries"].extend(entries)
            conv["updated"] = time.time()
            self._save(conv)

    def list(self) -> list[dict]:
        out = []
        for p in self.base.glob("*.json"):
            try:
                c = json.loads(p.read_text(encoding="utf-8"))
                out.append({"id": c["id"], "title": c["title"], "updated": c["updated"], "count": len(c["entries"])})
            except (OSError, ValueError, KeyError):
                continue
        return sorted(out, key=lambda c: c["updated"], reverse=True)

    def delete(self, cid: str) -> None:
        self._path(cid).unlink(missing_ok=True)

    @staticmethod
    def as_messages(conv: dict, limit: int | None = None) -> list[dict]:
        """把历史里的用户与助手文字还原成模型消息，作为后续任务的上下文。

        如果这个会话被压缩过（存在 role="compact" 的记录），只从最近一次压缩点开始还原，
        并把压缩摘要当成一条助手消息放在最前面——更早的原文不再发给模型，但仍然完整保存在
        会话文件里，界面上还能看到（只是会被灰掉）。
        """
        entries = conv["entries"]
        last_compact = None
        for i in range(len(entries) - 1, -1, -1):
            if entries[i].get("role") == "compact":
                last_compact = i
                break
        msgs = []
        if last_compact is not None:
            msgs.append({"role": "assistant", "content": f"[更早对话的摘要]\n{entries[last_compact]['text']}"})
            entries = entries[last_compact + 1:]
        msgs += [{"role": e["role"], "content": e["text"]} for e in entries
                if e.get("role") in ("user", "assistant") and e.get("text")]
        return msgs[-limit:] if limit else msgs

    #: A dedicated compaction prompt — written to be thorough and structured (bullet points, not prose) so
    #: a fresh model turn can continue the task with nothing important silently lost.
    COMPACT_PROMPT = (
        "You are compacting the conversation history of a coding assistant so it can continue with a much "
        "shorter context. Write a thorough, structured recap, in the same language the conversation below "
        "used, that a fresh instance of yourself could read and continue seamlessly from, with nothing "
        "important lost. Use short bullet points under headings, not prose. Include:\n"
        "- The user's overall goal(s), and any explicit constraints/preferences they stated (coding style, "
        "things to avoid, decisions already made and why).\n"
        "- What has actually been done so far: files created/edited/deleted (exact paths), commands run and "
        "their outcomes, tests passing/failing.\n"
        "- Any open questions, unresolved errors, or TODOs that still need attention.\n"
        "- Anything the user corrected you on, so the same mistake isn't repeated.\n"
        "Be concrete and specific (exact file paths, function/variable names, error messages) rather than "
        "vague. Do not include pleasantries, apologies, or a restatement of these instructions. This summary "
        "fully replaces the earlier conversation for future turns — omitting something means it is genuinely "
        "forgotten, so err on the side of including a detail rather than dropping it.\n\n"
        "Conversation to compact:\n"
    )

    def compact(self, cid: str, summary: str) -> None:
        self.append(cid, [{"role": "compact", "text": summary, "ts": time.time()}])
