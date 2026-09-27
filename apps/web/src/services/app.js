// Service layer. UI components subscribe to `state` and to `events`; they never talk to the Bridge protocol
// details directly for anything stateful (tabs, workspace, agent status, AI edits).

import { runtime } from "./runtime/index.js";
import { createStore, settingsStore, saveSettings } from "./store.js";


class Emitter {
  constructor() { this.h = new Map(); }
  on(e, fn) { if (!this.h.has(e)) this.h.set(e, new Set()); this.h.get(e).add(fn); return () => this.h.get(e).delete(fn); }
  emit(e, d) { for (const fn of this.h.get(e) || []) { try { fn(d); } catch (err) { console.error(err); } } }
}
export const events = new Emitter();
export { runtime };
// Temporary compatibility object for the existing integration suite. Product UI must not use it.
export const bridge = {
  get status() { return runtime.status; },
  rpc: (method, params, timeoutMs) => runtime.call(method, params, timeoutMs),
  on: (event, fn) => runtime.on(event, fn),
  onStatus: (fn) => runtime.onStatus(fn),
  close: (silent) => runtime.close(silent),
};

const TASK_STAGE_DEFS = [
  ["understand", "理解目标"],
  ["explore", "探索项目"],
  ["change", "执行修改"],
  ["verify", "验证结果"],
  ["complete", "完成"],
];
const freshTaskStages = () => TASK_STAGE_DEFS.map(([id, label], i) => ({ id, label, state: i === 0 ? "active" : "pending" }));
const emptyLive = () => ({ goal: "", startedAt: null, finishedAt: null, status: "idle", activities: [], stages: [] });

export const state = createStore({
  conn: "offline", hello: null, workspace: null,
  tabs: [], active: null,
  agent: { running: false, state: "idle", detail: "", taskId: null },
  live: emptyLive(),
  editing: {},             // path -> true while the agent is writing that file
  approvals: [],
  profiles: [], permissions: null,
  git: { is_repo: false, files: {} },   // Git 状态：文件树角标和 Git 面板使用
  conversationId: null,               // 当前对话，任务之间延续上下文
});

const setAgent = (patch) => state.set((s) => ({ agent: { ...s.agent, ...patch } }));
const setLive = (patch) => state.set((s) => ({ live: { ...s.live, ...patch } }));
const LIVE_LIMIT = 40;
function advanceLiveStage(id) {
  state.set((s) => {
    const stages = (s.live.stages?.length ? s.live.stages : freshTaskStages()).map((x) => ({ ...x }));
    const target = stages.findIndex((x) => x.id === id);
    const current = stages.reduce((n, x, i) => (x.state === "active" || x.state === "done" ? Math.max(n, i) : n), 0);
    if (target < 0 || target <= current) return {};
    for (let i = 0; i < target; i++) if (["pending", "active"].includes(stages[i].state)) stages[i].state = "done";
    if (!["done", "error", "stopped"].includes(stages[target].state)) stages[target].state = "active";
    return { live: { ...s.live, stages } };
  });
}
function finishLiveStages(status) {
  state.set((s) => {
    const stages = (s.live.stages?.length ? s.live.stages : freshTaskStages()).map((x) => ({ ...x }));
    const failed = status === "error", stopped = status === "stopped", incomplete = status === "incomplete";
    for (const stage of stages) {
      if (stage.id === "complete") {
        stage.state = failed ? "error" : stopped ? "stopped" : incomplete ? "incomplete" : "done";
      } else if (stage.state === "active") {
        stage.state = failed ? "error" : stopped ? "stopped" : "done";
      } else if (stage.state === "pending") stage.state = "skipped";
    }
    return { live: { ...s.live, stages } };
  });
}
function upsertLiveActivity(callId, patch) {
  state.set((s) => {
    const now = Date.now();
    const activities = [...(s.live.activities || [])];
    const i = activities.findIndex((x) => x.callId === callId);
    if (i >= 0) activities[i] = { ...activities[i], ...patch, updatedAt: now };
    else activities.push({ callId, startedAt: now, updatedAt: now, ...patch });
    return { live: { ...s.live, activities: activities.slice(-LIVE_LIMIT) } };
  });
}
export const tabOf = (path) => state.get().tabs.find((t) => t.path === path);
export const activeTab = () => tabOf(state.get().active);
const patchTab = (path, patch) => state.set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) }));

// ---- connection ------------------------------------------------------------------------------------
runtime.onStatus((conn) => state.set({ conn }));

runtime.on("hello", (hello) => {
  state.set({
    hello, workspace: hello.workspace, profiles: hello.profiles, permissions: hello.permissions,
    approvals: hello.approvals || [],
  });
  setAgent({ running: hello.agent.running, taskId: hello.agent.task_id, state: hello.agent.running ? "thinking" : "idle" });
});

export async function initConnection() {
  const remembered = settingsStore.get().bridge.remembered;
  return runtime.discover(remembered);
}

export async function connectManual(target) {
  await runtime.connect(target, { timeout: 6000 });
  const rem = settingsStore.get().bridge.remembered.filter((t) => `${t.host}:${t.port}` !== `${target.host}:${target.port}`);
  saveSettings({ bridge: { remembered: [target, ...rem].slice(0, 6) } });
}

// ---- workspace / files -------------------------------------------------------------------------------
export async function openWorkspace(location) {
  const params = typeof location === "string" ? { path: location } : { location };
  const ws = await runtime.workspace.open(params);
  state.set({ workspace: ws, tabs: [], active: null, editing: {}, conversationId: null, live: emptyLive() });
  if (ws?.capabilities?.git === false) state.set({ git: { is_repo: false, files: {} } });
  else refreshGit();
  return ws;
}

// ---- Git 状态（文件树上的角标、Git 面板的分支信息）-----------------------------------------------------------------------
export async function refreshGit() {
  const workspace = state.get().workspace;
  if (runtime.status !== "online" || !workspace || workspace?.capabilities?.git === false) return state.set({ git: { is_repo: false, files: {} } });
  try {
    const st = await runtime.git.status();
    const files = {};
    for (const f of st.files || []) files[f.path] = f.index === "?" ? "U" : f.index !== " " ? f.index : f.worktree;
    state.set({ git: { ...st, files } });
  } catch { state.set({ git: { is_repo: false, files: {} } }); }
}
const refreshGitSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(refreshGit, 700); }; })();
runtime.on("git.changed", refreshGitSoon);
runtime.on("fs.changed", refreshGitSoon);
runtime.on("fs.external", refreshGitSoon);

// ---- 会话（每个项目可以有多个对话，任务之间带着上下文）--------------------------------------------------------------------
const convKey = () => "dfx.conv." + (state.get().workspace?.roots?.[0] || "");
export function setConversation(id, { load = false } = {}) {
  state.set({ conversationId: id });
  try { id ? localStorage.setItem(convKey(), id) : localStorage.removeItem(convKey()); } catch { /* 存储可能被禁用 */ }
  if (load) events.emit("conversation:load", id);
}
export function restoreConversation() {
  try { const id = localStorage.getItem(convKey()); if (id) setConversation(id, { load: true }); } catch { /* ignore */ }
}

export async function openFile(path, { preview = false } = {}) {
  const existing = tabOf(path);
  if (existing) { state.set({ active: path }); return existing; }
  const res = await runtime.files.read({ path });
  const tab = { path: res.path, text: res.content || "", savedText: res.content || "", revision: res.revision,
    binary: !!res.binary, dirty: false, preview, pinned: false, conflict: false };
  state.set((s) => {
    let tabs = s.tabs;
    if (preview) tabs = tabs.filter((t) => !(t.preview && !t.dirty));       // a new preview replaces the old one
    return { tabs: [...tabs, tab], active: tab.path };
  });
  return tab;
}

const DEMO_BEFORE = "def add(a, b):\n    return a - b\n\ndef greet(name):\n    print('hi', name)\n\nresult = add(1, 2)\n";
const DEMO_AFTER = "def greet(name):\n    print('hello,', name)\n\ndef add(a, b):\n    return a + b\n\ntotal = add(1, 2)\nprint(total)\n";

/** Web-mode scratch pad: an unsaved buffer so the editor (and Diffusion) work without any Bridge. */
export function openScratch(text = "") {
  const path = "scratch.py";
  if (!tabOf(path)) state.set((s) => ({ tabs: [...s.tabs, { path, text, savedText: text, revision: "", binary: false, dirty: false, preview: false, pinned: false, conflict: false, virtual: true }], active: path }));
  else state.set({ active: path });
  return path;
}

/** Show the Diffusion effect with no AI or Bridge: an "AI" rewrites the scratch pad. */
export function demoDiffusion() {
  const path = openScratch(DEMO_BEFORE);
  patchTab(path, { text: DEMO_BEFORE, savedText: DEMO_BEFORE, dirty: false });
  events.emit("editor:replace", { path, text: DEMO_BEFORE });
  setTimeout(() => {
    patchTab(path, { text: DEMO_AFTER, savedText: DEMO_AFTER, dirty: false });
    events.emit("editor:external", { path, before: DEMO_BEFORE, after: DEMO_AFTER, actor: "agent", animate: true });
  }, 700);
}

export function activate(path) { state.set({ active: path }); }

export function closeTab(path) {
  state.set((s) => {
    const i = s.tabs.findIndex((t) => t.path === path);
    if (i < 0) return {};
    const tabs = s.tabs.filter((t) => t.path !== path);
    const active = s.active === path ? (tabs[Math.min(i, tabs.length - 1)] || {}).path || null : s.active;
    return { tabs, active };
  });
}
export function closeOthers(path) { state.set((s) => ({ tabs: s.tabs.filter((t) => t.path === path || t.pinned), active: path })); }
export function closeRight(path) {
  state.set((s) => { const i = s.tabs.findIndex((t) => t.path === path); return { tabs: s.tabs.filter((t, k) => k <= i || t.pinned) }; });
}
export function togglePin(path) { const t = tabOf(path); if (t) patchTab(path, { pinned: !t.pinned, preview: false }); }

/** Called by the editor as the user types. */
export function updateText(path, text) {
  const t = tabOf(path);
  if (!t) return;
  patchTab(path, { text, dirty: text !== t.savedText, preview: false });
}

export async function saveTab(path) {
  const t = tabOf(path);
  if (!t || !t.dirty) return { saved: false };
  if (t.virtual) throw new Error("草稿本不会保存到任何地方。请先打开项目文件夹，才能保存文件。");
  const res = await runtime.files.write({ path, content: t.text, base_revision: t.revision });
  patchTab(path, { savedText: t.text, revision: res.revision, dirty: false, conflict: false });
  return { saved: true };
}

/** Resolve a conflict banner: take the disk version or overwrite disk with the local buffer. */
export async function resolveConflict(path, keep) {
  const t = tabOf(path);
  if (!t) return;
  const disk = await runtime.files.read({ path });
  if (keep === "theirs") {
    patchTab(path, { text: disk.content, savedText: disk.content, revision: disk.revision, dirty: false, conflict: false });
    events.emit("editor:replace", { path, text: disk.content });
  } else {
    patchTab(path, { revision: disk.revision, conflict: false });
    await saveTab(path);
  }
}

export async function refreshTabFromDisk(path) {
  const disk = await runtime.files.read({ path });
  patchTab(path, { text: disk.content, savedText: disk.content, revision: disk.revision, dirty: false, conflict: false });
  events.emit("editor:replace", { path, text: disk.content });
}

// ---- events from the Bridge ------------------------------------------------------------------------------
runtime.on("workspace.opened", (ws) => state.set({ workspace: ws }));
runtime.on("workspace.closed", () => state.set({ workspace: null, tabs: [], active: null }));
runtime.on("profiles.changed", (d) => state.set({ profiles: d.profiles }));
runtime.on("workspace.recent_changed", (d) => state.set((s) => ({ hello: s.hello ? { ...s.hello, recent: d.recent || [] } : s.hello })));
runtime.on("permissions.changed", (d) => state.set((s) => ({ permissions: { ...s.permissions, ...d } })));

function seedAgentFollowTab(c) {
  if (tabOf(c.path)) { state.set({ active: c.path }); return tabOf(c.path); }
  const before = typeof c.before_text === "string" ? c.before_text : "";
  const tab = {
    path: c.path, text: before, savedText: before, revision: c.before_rev || "absent",
    binary: false, dirty: false, preview: false, pinned: false, conflict: false,
  };
  state.set((s) => ({ tabs: [...s.tabs.filter((t) => !(t.preview && !t.dirty)), tab], active: c.path }));
  return tabOf(c.path);
}

async function followAgentChangeFromDisk(c) {
  if (!settingsStore.get().followAgentEdits || c.actor !== "agent" || c.kind === "delete") return;
  try {
    const disk = await runtime.files.read({ path: c.path });
    if (disk.binary) return;
    const synthetic = { ...c, after_text: disk.content || "", after_rev: disk.revision };
    applyFsChanged(synthetic);
  } catch { /* folders and files removed again before the read are intentionally ignored */ }
}

function applyFsChanged(c) {
  const settings = settingsStore.get();
  const follow = c.actor === "agent" && !!settings.followAgentEdits && c.kind !== "delete";
  if (follow && typeof c.after_text === "string") seedAgentFollowTab(c);

  const t = tabOf(c.path);
  if (!t) return;
  if (c.kind === "delete") { if (!t.dirty) closeTab(c.path); else patchTab(c.path, { conflict: true }); return; }
  if (c.after_text == null) { refreshTabFromDisk(c.path).catch(() => {}); return; }
  if (c.after_text === t.savedText && c.after_rev === t.revision) return;   // our own save echoing back
  if (c.actor === "user" && c.after_rev === t.revision) return;
  if (t.dirty && t.text !== c.after_text) { patchTab(c.path, { conflict: true }); return; }   // never clobber unsaved typing
  const animate = (c.actor === "agent" && settings.anim.playFor.ai) || (c.actor === "system" && settings.anim.playFor.undo);
  patchTab(c.path, { text: c.after_text, savedText: c.after_text, revision: c.after_rev, dirty: false, conflict: false });
  events.emit("editor:external", { path: c.path, before: c.before_text, after: c.after_text, actor: c.actor, animate, reveal: follow });
}

runtime.on("fs.changed", (c) => {
  events.emit("tree:refresh", c);
  if (c.actor === "agent" && c.kind !== "delete") {
    events.emit("tree:reveal", { path: c.path, scroll: !!settingsStore.get().followAgentEdits });
  }
  if (c.kind === "rename" && c.old_path && tabOf(c.old_path)) {
    state.set((s) => ({ tabs: s.tabs.map((x) => (x.path === c.old_path ? { ...x, path: c.path } : x)), active: s.active === c.old_path ? c.path : s.active }));
  }
  if (c.actor === "agent" && c.kind !== "delete" && c.after_text == null && settingsStore.get().followAgentEdits) {
    // 复制/重命名等事件可能只带路径；跟随模式下先读回真实内容，避免先刷新一次又重复播放动画。
    followAgentChangeFromDisk(c);
    return;
  }
  applyFsChanged(c);
});

runtime.on("fs.external", async (d) => {
  events.emit("tree:refresh", null);
  for (const ch of d.changes) {
    const t = tabOf(ch.path);
    if (!t || ch.kind !== "modify") continue;
    try {
      const h = await runtime.files.hash({ path: ch.path });
      if (h.revision === t.revision) continue;
      if (t.dirty) patchTab(ch.path, { conflict: true });
      else await refreshTabFromDisk(ch.path);
    } catch { /* file vanished */ }
  }
});

// ---- agent -------------------------------------------------------------------------------------------------
const callPaths = new Map();
const WRITERS = new Set(["fs_patch", "fs_write", "fs_create", "fs_delete", "fs_rename", "fs_copy"]);

runtime.on("agent.started", (d) => {
  setAgent({ running: true, taskId: d.task_id, state: "thinking", detail: "" });
  const stages = state.get().live.stages?.length ? state.get().live.stages : freshTaskStages();
  setLive({ startedAt: Date.now(), finishedAt: null, status: "running", activities: [], stages });
});
runtime.on("agent.status", (d) => {
  setAgent({ state: d.state, detail: d.detail || "", running: !["idle", "stopped", "error"].includes(d.state), taskId: d.task_id });
  if (!(d.state === "idle" && state.get().live.finishedAt)) setLive({ status: d.state || "working" });
});
runtime.on("agent.done", (d = {}) => {
  setAgent({ running: false });
  const status = d.status || "done";
  finishLiveStages(status);
  setLive({ status, finishedAt: Date.now() });
  state.set({ editing: {} });
});
runtime.on("agent.tool", (d) => {
  if (d.args) callPaths.set(d.call_id, d.args.path || d.args.from || d.args.to);
  const p = callPaths.get(d.call_id) || "";
  upsertLiveActivity(d.call_id, { tool: d.tool, state: d.state, path: p, detail: d.detail || "" });
  if (["preparing", "running", "done"].includes(d.state)) {
    if (["fs_read", "fs_list", "fs_search", "fs_glob", "fs_multi_read", "web_fetch"].includes(d.tool)) advanceLiveStage("explore");
    else if (WRITERS.has(d.tool)) advanceLiveStage("change");
    else if (["shell_run", "terminal_read"].includes(d.tool)) advanceLiveStage("verify");
  }
  if (!WRITERS.has(d.tool)) return;
  if (!p) return;
  if (d.state === "running") state.set((s) => ({ editing: { ...s.editing, [p]: true } }));
  else if (["done", "error", "denied"].includes(d.state)) state.set((s) => { const e = { ...s.editing }; delete e[p]; return { editing: e }; });
});
runtime.on("approval.request", (a) => state.set((s) => ({ approvals: [...s.approvals.filter((x) => x.approval_id !== a.approval_id), a] })));
runtime.on("approval.resolved", (a) => state.set((s) => ({ approvals: s.approvals.filter((x) => x.approval_id !== a.approval_id) })));

/** 返回开始页：关闭当前项目（同时停止正在运行的智能体和终端），清空标签页。 */
export async function goHome() {
  if (state.get().workspace && runtime.status === "online") await runtime.workspace.close().catch(() => {});
  state.set({ workspace: null, tabs: [], active: null, editing: {}, conversationId: null, git: { is_repo: false, files: {} }, live: emptyLive() });
  events.emit("conversation:load", null);
}

export function moveTab(path, dir) {
  state.set((s) => {
    const i = s.tabs.findIndex((t) => t.path === path), j = i + dir;
    if (i < 0 || j < 0 || j >= s.tabs.length) return {};
    const tabs = [...s.tabs];
    [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
    return { tabs };
  });
}

export async function startAgent(goal) {
  const s = settingsStore.get();
  setLive({ goal, startedAt: Date.now(), finishedAt: null, status: "starting", activities: [], stages: freshTaskStages() });
  const profile = s.agent.profile || state.get().profiles[0]?.id;
  if (!profile) {
    finishLiveStages("error");
    setLive({ status: "error", finishedAt: Date.now() });
    throw new Error("请先在「设置」里添加一个模型服务商");
  }
  const t = activeTab();
  const goalText = t ? `${goal}\n\n(The user currently has "${t.path}" open in the editor.)` : goal;
  try {
    const r = await runtime.agent.start({ goal: goalText, profile, mode: s.agent.mode, reasoning: s.agent.reasoning, web_search: !!s.agent.webSearch, limits: s.agent.limits, conversation_id: state.get().conversationId });
    if (r.conversation_id && r.conversation_id !== state.get().conversationId) setConversation(r.conversation_id);
    return r;
  } catch (e) {
    finishLiveStages("error");
    setLive({ status: "error", finishedAt: Date.now() });
    throw e;
  }
}
export const stopAgent = () => runtime.agent.stop();
export const respondApproval = (id, allow, scope = "once") => runtime.approval.respond({ approval_id: id, allow, scope });
