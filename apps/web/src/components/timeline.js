// Time Machine. Every agent task leaves a timeline. Any edit can be replayed (the same Diffusion animation, run
// on a read-only editor), reverted on its own, or the whole task can be undone in one tap.

import { h, icon, clear, toast, append } from "./dom.js";
import { openSheet, confirmDialog } from "./overlays.js";
import { CodeEditor } from "../editor/code-editor.js";
import { runtime } from "../services/app.js";

const STATUS = { done: "已完成", incomplete: "可能未完成", stopped: "已停止", error: "失败", running: "进行中" };
const EVENT_LABEL = {
  task_started: "开始", read: "探索", edit: "修改", build_failed: "验证失败",
  build_ok: "验证通过", task_complete: "完成", task_status: "结束",
};
const eventDetail = (ev) => ev.detail || ev.summary || "";
const eventPath = (ev) => ev.path || ev.arguments?.path || "";
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (ts) => new Date(ts * 1000).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Read-only editor that shows `before`, then lets the code flow into `after`. */
export function openReplay({ path, before, after }) {
  const ed = new CodeEditor({});
  const box = h("div", { class: "replay-box" }, ed.el);
  const play = async () => {
    ed.setDocument({ path, text: before ?? "", readOnly: true });
    await new Promise((r) => setTimeout(r, 450));
    await ed.applyExternal(after ?? "", { animate: true });
  };
  const sheet = openSheet({
    title: path, tall: true, body: box,
    footer: [h("button", { class: "btn tonal", type: "button", onclick: () => play() }, icon("play", 18), "重播"),
      h("button", { class: "btn text", type: "button", onclick: () => sheet.close() }, "关闭")],
  });
  setTimeout(play, 380);
  return sheet;
}

export function openTimeMachine(taskId = null) {
  const body = h("div");
  const sheet = openSheet({ title: "时光机", tall: true, body });

  async function showTasks() {
    clear(body);
    let tasks = [];
    try { tasks = (await runtime.checkpoint.tasks()).tasks; } catch (e) { body.appendChild(h("p", { class: "muted" }, e.message)); return; }
    if (!tasks.length) { body.appendChild(h("p", { class: "muted", style: { padding: "8px" } }, "还没有智能体任务。你运行的每个任务都会在这里留下完整的时间线。")); return; }
    for (const t of tasks) {
      body.appendChild(h("button", { class: "tm-task", type: "button", onclick: () => showTask(t.id) },
        h("div", null, t.goal.length > 90 ? t.goal.slice(0, 90) + "…" : t.goal),
        h("small", null, `${fmtDate(t.started)} · ${STATUS[t.status] || t.status} · ${t.files.length} 个文件`)));
    }
  }

  async function showTask(id) {
    clear(body);
    let m;
    try { m = await runtime.checkpoint.task({ task_id: id }); } catch (e) { toast(e.message); return; }
    const touched = Object.keys(m.files);
    const anyEdits = m.events.some((e) => e.type === "edit" && !e.reverted);
    append(body, [
      h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" } },
        h("button", { class: "icon-btn", type: "button", "aria-label": "返回", onclick: showTasks }, icon("back")),
        h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontWeight: 500 } }, m.goal.slice(0, 120)), h("small", { class: "muted" }, fmtDate(m.started) + " · " + (STATUS[m.status] || m.status)))),
      touched.length ? h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" } },
        h("button", { class: "btn filled small danger", type: "button", disabled: !anyEdits, onclick: () => revertTask(id) }, icon("undo", 16), "恢复到任务开始之前"),
        ...touched.map((p) => h("button", { class: "btn outlined small", type: "button", onclick: () => revertFile(id, p) }, "撤销 " + p.split("/").pop()))) : null]);

    const tl = h("div", { class: "tl" });
    for (const ev of m.events) {
      const acts = h("div", { class: "acts" });
      if (ev.type === "edit") {
        if (ev.kind !== "rename") acts.appendChild(h("button", { class: "btn tonal small", type: "button", onclick: () => replay(id, ev) }, icon("play", 14), "Replay"));
        if (!ev.reverted && ev.kind !== "rename") acts.appendChild(h("button", { class: "btn text small", type: "button", onclick: () => revertStep(id, ev) }, "撤销这一步"));
      }
      const detail = eventDetail(ev);
      const path = eventPath(ev);
      tl.appendChild(h("div", { class: `tl-ev ${ev.type}${ev.reverted ? " reverted" : ""}` },
        h("div", { class: "time" }, fmtTime(ev.ts)),
        h("div", { class: "ttl" },
          EVENT_LABEL[ev.type] ? h("span", { class: "tl-kind" }, EVENT_LABEL[ev.type]) : null,
          ev.title),
        path ? h("div", { class: "muted tl-path", title: path }, path) : null,
        detail && (ev.type.startsWith("build") || ev.type === "task_status") ? h("pre", null, detail) : null,
        acts.children.length ? acts : null));
    }
    body.appendChild(tl);
  }

  async function replay(id, ev) {
    try {
      const d = await runtime.checkpoint.diff({ task_id: id, seq: ev.seq });
      openReplay({ path: d.path, before: d.before, after: d.after });
    } catch (e) { toast(e.message); }
  }

  async function revertStep(id, ev) {
    try { await runtime.checkpoint.revertEvent({ task_id: id, seq: ev.seq }); toast("已撤销这一步"); showTask(id); }
    catch (e) {
      if (e.code === "CONFLICT" && await confirmDialog({ title: "后面的改动依赖这一步", message: "撤销这一步会丢掉同一个文件里在它之后做的修改。", confirmLabel: "仍然撤销", danger: true })) {
        try { await runtime.checkpoint.revertEvent({ task_id: id, seq: ev.seq, force: true }); toast("已撤销这一步"); showTask(id); } catch (e2) { toast(e2.message); }
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
