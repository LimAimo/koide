// Koide 1.0 Live Workspace: a compact, inspectable view of what the Agent is doing right now.

import { h, clear, icon } from "./dom.js";
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
      h("button", { class: "btn tonal", type: "button", onclick: () => { const id = state.get().agent.taskId; if (id && onOpenTimeline) onOpenTimeline(id); } }, icon("history", 17), "时光机"),
      h("button", { class: "btn text", type: "button", onclick: () => onOpenMemory && onOpenMemory() }, icon("file", 17), "项目记忆"),
    ],
  });

  function render(s = state.get()) {
    clear(body);
    const live = s.live || {};
    const running = !!s.agent.running;
    const goal = live.goal || (running ? "Koide 正在处理当前任务" : "");
    body.append(
      h("section", { class: "live-hero" },
        h("div", { class: "live-orb" + (running ? " running" : "") }),
        h("div", { class: "live-copy" },
          h("small", null, running ? (STATE[s.agent.state] || "工作中") : (STATE[live.status] || "暂无进行中的任务")),
          h("h3", null, goal || "现在很安静"),
          h("p", { class: "muted" }, running && s.agent.detail ? s.agent.detail : (live.finishedAt ? "最近一次任务 " + ago(live.finishedAt) + "结束" : "开始一个 Agent 任务后，这里会显示它正在做什么。")))),
    );

    const activities = [...(live.activities || [])].reverse();
    body.append(h("div", { class: "live-section-title" }, "实时活动"));
    if (!activities.length) {
      body.append(h("div", { class: "live-empty muted" }, running ? "Agent 正在组织下一步…" : "还没有可以显示的活动。"));
      return;
    }
    const list = h("div", { class: "live-activity-list" });
    for (const a of activities.slice(0, 24)) {
      list.append(h("div", { class: "live-activity " + (a.state || "") },
        h("div", { class: "live-activity-dot" }),
        h("div", { class: "live-activity-main" },
          h("div", { class: "live-activity-title" }, TOOL[a.tool] || a.tool || "处理"),
          a.path ? h("code", null, a.path) : null,
          a.detail ? h("small", { class: "muted" }, a.detail) : null),
        h("small", { class: "live-activity-state" }, ACT_STATE[a.state] || a.state || "")));
    }
    body.append(list);
  }
  off = state.subscribe(render);
  render();
  return sheet;
}
