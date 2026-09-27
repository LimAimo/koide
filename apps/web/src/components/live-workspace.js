// Koide 1.0 Live Workspace: a compact, inspectable view of what the Agent is doing right now.

import { h, icon } from "./dom.js";
import { openSheet } from "./overlays.js";
import { state } from "../services/app.js";

const TOOL = {
  fs_read: "读取文件", fs_list: "查看目录", fs_search: "搜索代码", fs_glob: "查找文件", fs_multi_read: "批量读取",
  fs_patch: "修改文件", fs_write: "写入文件", fs_create: "创建文件", fs_delete: "删除文件", fs_rename: "重命名", fs_copy: "复制文件",
  shell_run: "运行命令", terminal_read: "读取终端", web_fetch: "访问网页", ask_user: "等待你的回答",
};
const STATE = {
  starting: "正在开始", running: "进行中", thinking: "正在思考", reading: "正在读取", searching: "正在搜索",
  editing: "正在修改", working: "处理中", waiting_approval: "等待批准", done: "已完成", stopped: "已停止", error: "失败", idle: "空闲",
};
const ACT_STATE = { preparing: "准备", pending: "等待", waiting: "等待", running: "进行中", done: "完成", error: "失败", denied: "已拒绝" };
const STAGE_STATE = { active: "当前", done: "已完成", pending: "待处理", skipped: "未经过", error: "失败", stopped: "已停止", incomplete: "可能未完成" };

function ago(ts) {
  if (!ts) return "";
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return sec + " 秒前";
  const min = Math.round(sec / 60);
  return min < 60 ? min + " 分钟前" : Math.round(min / 60) + " 小时前";
}

export function openLiveWorkspace({ onOpenTimeline, onOpenMemory } = {}) {
  const body = h("div", { class: "live-workspace" });
  let off = null;
  const sheet = openSheet({
    title: "工作现场",
    tall: true,
    body,
    onClose: () => off && off(),
    footer: [
      h("button", { class: "btn tonal", type: "button", onclick: () => { const id = state.get().agent.taskId || state.get().live?.taskId; if (onOpenTimeline) onOpenTimeline(id || null); } }, icon("history", 17), "时光机"),
      h("button", { class: "btn text", type: "button", onclick: () => onOpenMemory && onOpenMemory() }, icon("file", 17), "项目记忆"),
    ],
  });

  const orb = h("div", { class: "live-orb" });
  const status = h("small"), goal = h("h3"), detail = h("p", { class: "muted" });
  const stageList = h("div", { class: "live-stage-list" });
  const flow = h("section", { class: "live-task-flow", "aria-label": "任务脉络" },
    h("div", { class: "live-section-title" }, "任务脉络"), stageList);
  const list = h("div", { class: "live-activity-list" });
  const empty = h("div", { class: "live-empty muted" });
  body.append(h("section", { class: "live-hero" }, orb, h("div", { class: "live-copy" }, status, goal, detail)),
    flow, h("div", { class: "live-section-title" }, "实时活动"), empty, list);
  const stageNodes = new Map(), activityNodes = new Map();
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function reconcile(parent, map, items, keyOf, create, update) {
    const keep = new Set();
    items.forEach((item, index) => {
      const key = keyOf(item); keep.add(key);
      let record = map.get(key);
      if (!record) { record = create(item); map.set(key, record); }
      update(record, item);
      const at = parent.children[index];
      if (at !== record.el) parent.insertBefore(record.el, at || null);
    });
    for (const [key, record] of map) if (!keep.has(key)) { record.el.remove(); map.delete(key); }
  }
  function render(s = state.get()) {
    const live = s.live || {}, running = !!s.agent.running;
    orb.classList.toggle("running", running);
    setText(status, running ? (STATE[s.agent.state] || "工作中") : (STATE[live.status] || "暂无进行中的任务"));
    setText(goal, live.goal || (running ? "Koide 正在处理当前任务" : "现在很安静"));
    setText(detail, running && s.agent.detail ? s.agent.detail : (live.finishedAt ? "最近一次任务 " + ago(live.finishedAt) + "结束" : "开始任务后，这里会显示实际活动。"));
    const stages = live.stages || [];
    flow.hidden = !stages.length;
    reconcile(stageList, stageNodes, stages, (stage) => stage.id, () => {
      const label = h("span", { class: "live-stage-label" }), state = h("small");
      return { label, state, el: h("div", null, h("span", { class: "live-stage-mark" }), label, state) };
    }, (record, stage) => {
      record.el.className = "live-stage " + stage.state;
      record.el.setAttribute("title", STAGE_STATE[stage.state] || stage.state);
      if (stage.state === "active") record.el.setAttribute("aria-current", "step");
      else record.el.removeAttribute("aria-current");
      setText(record.label, stage.label); setText(record.state, STAGE_STATE[stage.state] || stage.state);
    });
    const activities = [...(live.activities || [])].reverse().slice(0, 24);
    empty.hidden = !!activities.length;
    setText(empty, running ? "Agent 正在组织下一步…" : "还没有可以显示的活动。");
    reconcile(list, activityNodes, activities, (activity) => activity.viewId || activity.callId, () => {
      const title = h("div", { class: "live-activity-title" }), path = h("code"), detail = h("small", { class: "muted" });
      const state = h("small", { class: "live-activity-state" });
      return { title, path, detail, state, el: h("div", null, h("div", { class: "live-activity-dot" }),
        h("div", { class: "live-activity-main" }, title, path, detail), state) };
    }, (record, activity) => {
      record.el.className = "live-activity " + (activity.state || "");
      record.el.dataset.callId = activity.callId;
      setText(record.title, TOOL[activity.tool] || activity.tool || "处理");
      record.path.hidden = !activity.path; setText(record.path, activity.path || "");
      record.detail.hidden = !activity.detail; setText(record.detail, activity.detail || "");
      setText(record.state, ACT_STATE[activity.state] || activity.state || "");
    });
  }

  off = state.subscribe(render);
  render();
  return sheet;
}
