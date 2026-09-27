// Time Machine. Every agent task leaves a timeline. Any edit can be replayed (the same Diffusion animation, run
// on a read-only editor), reverted on its own, or the whole task can be undone in one tap.

import { h, icon, clear, toast, append } from "./dom.js";
import { openSheet, confirmDialog } from "./overlays.js";
import { CodeEditor } from "../editor/code-editor.js";
import { runtime } from "../services/app.js";
import { reducedMotion } from "../services/store.js";
import { lineDiff, validationStories } from "../services/history-diff.js";
import { createHistoryDiff, diffStats } from "./history-diff.js";

const STATUS = { done: "已完成", incomplete: "可能未完成", stopped: "已停止", error: "失败", running: "进行中" };
const EVENT_LABEL = {
  task_started: "开始", read: "探索", edit: "修改", build_failed: "验证失败",
  build_ok: "验证通过", task_complete: "完成", task_status: "结束",
  task_stopped: "停止", task_error: "失败", task_incomplete: "可能未完成",
};
const eventDetail = (ev) => ev.detail || ev.summary || "";
const eventPath = (ev) => ev.path || ev.arguments?.path || "";
const editLabel = (ev) => ({ create: "创建", write: "写入", patch: "修改", delete: "删除", rename: "重命名", copy: "复制" }[ev.kind] || "修改");
const editTitle = (ev) => ev.type === "edit" ? `${editLabel(ev)} · ${eventPath(ev).split("/").pop() || ev.title}` : ev.title;
const callShort = (ev) => ev.call_id ? `调用 ${String(ev.call_id).slice(0, 10)}` : "";
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (ts) => new Date(ts * 1000).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Read-only editor that shows `before`, then lets the code flow into `after`. */
export function openReplay({ path, before, after }) {
  const ed = new CodeEditor({});
  let closed = false, generation = 0, timer;
  const box = h("div", { class: "replay-box" }, ed.el);
  const play = async () => {
    const current = ++generation;
    ed.setDocument({ path, text: before ?? "", readOnly: true });
    await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 450));
    if (closed || current !== generation) return;
    await ed.applyExternal(after ?? "", { animate: true });
  };
  const sheet = openSheet({
    title: path, tall: true, body: box,
    onClose: () => { closed = true; generation++; clearTimeout(timer); ed.destroy(); },
    footer: [h("button", { class: "btn tonal", type: "button", onclick: () => play() }, icon("play", 18), "重播"),
      h("button", { class: "btn text", type: "button", onclick: () => sheet.close() }, "关闭")],
  });
  timer = setTimeout(play, reducedMotion() ? 0 : 320);
  return sheet;
}

export function openTimeMachine(taskId = null) {
  const body = h("div");
  let generation = 0, closed = false;
  const sheet = openSheet({ title: "时光机", tall: true, body, onClose: () => { closed = true; generation++; } });
  const message = (label) => { clear(body); body.appendChild(h("p", { class: "muted", role: "status" }, label)); };
  function failed(error, retry) {
    message(error.message || "加载失败");
    body.appendChild(h("button", { class: "btn tonal", type: "button", onclick: retry }, "重试"));
  }

  async function showTasks() {
    const current = ++generation;
    message("正在读取任务…");
    let tasks = [];
    try { tasks = (await runtime.checkpoint.tasks()).tasks; } catch (e) { if (!closed && current === generation) failed(e, showTasks); return; }
    if (closed || current !== generation) return;
    clear(body);
    if (!tasks.length) { body.appendChild(h("p", { class: "muted", style: { padding: "8px" } }, "还没有智能体任务。你运行的每个任务都会在这里留下完整的时间线。")); return; }
    for (const t of tasks) {
      body.appendChild(h("button", { class: "tm-task", type: "button", onclick: () => showTask(t.id) },
        h("div", null, t.goal.length > 90 ? t.goal.slice(0, 90) + "…" : t.goal),
        h("small", null, `${fmtDate(t.started)} · ${STATUS[t.status] || t.status} · ${t.files.length} 个文件`)));
    }
  }

  async function showTask(id) {
    const current = ++generation;
    message("正在读取时间线…");
    let m;
    try { m = await runtime.checkpoint.task({ task_id: id }); } catch (e) { if (!closed && current === generation) failed(e, () => showTask(id)); return; }
    if (closed || current !== generation) return;
    clear(body);
    const touched = Object.keys(m.files);
    const anyEdits = m.events.some((e) => e.type === "edit" && !e.reverted);
    const stories = validationStories(m.events);
    const eventNodes = new Map(), statNodes = new Map();
    const jump = (event) => { const node = eventNodes.get(event.seq); node?.scrollIntoView({ block: "start" }); node?.focus({ preventScroll: true }); };
    append(body, [
      h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" } },
        h("button", { class: "icon-btn", type: "button", "aria-label": "返回", onclick: showTasks }, icon("back")),
        h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontWeight: 500 } }, m.goal.slice(0, 120)), h("small", { class: "muted" }, fmtDate(m.started) + " · " + (STATUS[m.status] || m.status)))),
      ...stories.map((story) => h("div", { class: `tm-story ${story.state}` },
        icon(story.state === "open" || story.state === "stale" ? "warning" : "check", 18),
        h("div", null,
          h("strong", null, ({ fixed: "验证失败后修改并重新通过", open: "最近一次验证仍未通过", retried: "重新验证通过，期间没有文件修改", stale: "曾验证通过，之后的修改或撤销尚需再验证" })[story.state]),
          h("small", { class: "muted" }, story.command || "旧记录没有命令信息，无法确认是否重新验证"),
          h("div", { class: "tm-story-steps" },
            h("button", { class: "btn text small", type: "button", onclick: () => jump(story.failure) }, "失败"),
            ...story.edits.map((edit) => h("button", { class: "btn text small", type: "button", onclick: () => jump(edit) }, `修改 #${edit.seq}${edit.reverted ? "（已撤销）" : ""}`)),
            story.pass ? h("button", { class: "btn text small", type: "button", onclick: () => jump(story.pass) }, "通过") : null)))),
      touched.length ? h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" } },
        h("button", { class: "btn filled small danger", type: "button", disabled: !anyEdits, onclick: () => revertTask(id) }, icon("undo", 16), "恢复到任务开始之前"),
        ...touched.map((p) => h("button", { class: "btn outlined small", type: "button", onclick: () => revertFile(id, p) }, "撤销 " + p.split("/").pop()))) : null]);

    const tl = h("div", { class: "tl" });
    for (const ev of m.events) {
      const acts = h("div", { class: "acts" });
      if (ev.type === "edit") {
        if (ev.kind !== "rename") acts.appendChild(h("button", { class: "btn tonal small", type: "button", onclick: () => replay(id, ev) }, icon("play", 14), "查看改动"));
        if (!ev.reverted && ev.kind !== "rename") acts.appendChild(h("button", { class: "btn text small", type: "button", onclick: () => revertStep(id, ev) }, "撤销到这一步之前"));
      }
      const detail = eventDetail(ev);
      const path = eventPath(ev);
      const stats = h("span", { class: "tl-stats muted" }, ev.type === "edit" && ev.kind !== "rename" ? "读取差异…" : "");
      if (ev.type === "edit" && ev.kind !== "rename") statNodes.set(ev.seq, stats);
      const node = h("div", { class: `tl-ev ${ev.type}${ev.reverted ? " reverted" : ""}`, tabindex: "-1", dataset: { seq: ev.seq } },
        h("div", { class: "time" }, fmtTime(ev.ts)),
        h("div", { class: "ttl" },
          EVENT_LABEL[ev.type] ? h("span", { class: "tl-kind" }, EVENT_LABEL[ev.type]) : null,
          editTitle(ev),
          ev.reverted ? h("span", { class: "tl-reverted" }, "已撤销") : null),
        path ? h("div", { class: "muted tl-path", title: path }, path) : null,
        callShort(ev) ? h("small", { class: "muted tl-call", title: ev.call_id }, callShort(ev)) : null,
        detail && (ev.type.startsWith("build") || ev.type.startsWith("task_")) ? h("pre", null, detail) : null,
        ev.type === "edit" ? stats : null,
        acts.children.length ? acts : null);
      eventNodes.set(ev.seq, node); tl.appendChild(node);
    }
    const files = h("div", { class: "tm-files" });
    const groups = new Map();
    for (const ev of m.events.filter((event) => event.type === "edit")) {
      const path = eventPath(ev);
      if (!groups.has(path)) groups.set(path, { path, events: [], added: 0, deleted: 0, done: 0, unavailable: 0 });
      groups.get(path).events.push(ev);
    }
    for (const group of groups.values()) {
      group.stats = h("span", { class: "muted" }, "读取差异…");
      files.appendChild(h("button", { class: "tm-file", type: "button", onclick: () => jump(group.events[0]) },
        h("code", null, group.path), group.stats));
    }
    if (groups.size) body.append(h("p", { class: "tm-file-note muted" }, "文件改动 · 逐步累计（含已撤销记录）"), files);
    body.appendChild(tl);
    const pending = m.events.filter((event) => event.type === "edit");
    async function loadStats() {
      while (pending.length && !closed && current === generation) {
        const ev = pending.shift(), group = groups.get(eventPath(ev));
        let diff;
        try {
          if (ev.kind === "rename") throw new Error("重命名记录不提供行差异");
          const data = await runtime.checkpoint.diff({ task_id: id, seq: ev.seq });
          diff = data.text_available === false ? { limited: true } : lineDiff(data.before, data.after);
        } catch (error) { diff = { limited: true, message: error.message }; }
        if (closed || current !== generation) return;
        const node = statNodes.get(ev.seq);
        if (node) { clear(node); node.appendChild(diff.limited ? h("small", { title: diff.message || "" }, "行差异不可用") : diffStats(diff)); }
        group.done++;
        if (diff.limited) group.unavailable++; else { group.added += diff.added; group.deleted += diff.deleted; }
        clear(group.stats);
        if (group.done < group.events.length) group.stats.textContent = "读取差异…";
        else if (group.unavailable) group.stats.textContent = `${group.events.length} 次修改 · ${group.unavailable} 条行差异不可用`;
        else group.stats.appendChild(diffStats(group));
      }
    }
    void Promise.all([loadStats(), loadStats(), loadStats()]);
  }

  async function replay(id, ev) {
    const content = h("div", null, h("p", { class: "muted", role: "status" }, "正在读取修改快照…"));
    let active = true;
    const view = openSheet({ title: eventPath(ev), tall: true, body: content, onClose: () => { active = false; } });
    try {
      const d = await runtime.checkpoint.diff({ task_id: id, seq: ev.seq });
      if (!active) return;
      clear(content);
      content.append(h("p", { class: "muted tm-diff-source" }, `记录 #${ev.seq}${ev.call_id ? " · 调用 " + ev.call_id : ""}${ev.reverted ? " · 已撤销，以下保留当时的改动" : ""}`), createHistoryDiff(d));
      if (d.text_available !== false) content.appendChild(h("button", { class: "btn tonal", type: "button", onclick: () => openReplay(d) }, icon("play", 18), "动画重播"));
    } catch (e) { if (active) { clear(content); content.appendChild(h("p", { class: "muted", role: "status" }, e.message)); } }
  }

  async function revertStep(id, ev) {
    try { await runtime.checkpoint.revertEvent({ task_id: id, seq: ev.seq }); toast("已恢复到这一步之前"); showTask(id); }
    catch (e) {
      if (e.code === "CONFLICT" && await confirmDialog({ title: "后续修改依赖这个版本", message: "恢复到这一步之前，会同时移除同一文件在它之后的修改。其他文件不受影响。", confirmLabel: "继续恢复", danger: true })) {
        try { await runtime.checkpoint.revertEvent({ task_id: id, seq: ev.seq, force: true }); toast("已恢复到这一步之前"); showTask(id); } catch (e2) { toast(e2.message); }
      } else if (e.code !== "CONFLICT") toast(e.message);
    }
  }
  async function revertFile(id, path) {
    try { await runtime.checkpoint.revertFile({ task_id: id, path }); toast(`已恢复 ${path.split("/").pop()}`); showTask(id); } catch (e) { toast(e.message); }
  }
  async function revertTask(id) {
    if (!(await confirmDialog({ title: "恢复工作区？", message: "这个任务改动过的所有文件都会恢复成任务开始前的样子；它新建的文件会被移到回收站。", confirmLabel: "恢复", danger: true }))) return;
    try { const r = await runtime.checkpoint.revertTask({ task_id: id }); toast(`已恢复 ${r.reverted.length} 个文件`); showTask(id); } catch (e) { toast(e.message); }
  }

  taskId ? showTask(taskId) : showTasks();
  return sheet;
}
