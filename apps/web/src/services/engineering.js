import { runtime } from "./runtime/index.js";
import { state, activeTab, events } from "./app.js";

export const projectKey = () => JSON.stringify(state.get().workspace?.location || state.get().workspace?.roots || null);
export async function readRecord(key) { return runtime.engineering.get({ key }); }
export async function changeRecord(key, change) {
  const project = projectKey(), previous = await readRecord(key);
  const value = await change(structuredClone(previous.value));
  if (project !== projectKey()) throw new Error("项目已切换，请重新操作");
  const saved = await runtime.engineering.put({ key, value, base_revision: previous.revision });
  events.emit("engineering:changed", { key });
  return saved;
}
export async function pinContext(pin) {
  const content = String(pin.content || "");
  if (content.length > 24000) throw new Error("单项上下文最多 24000 字，请选择函数或行范围");
  return changeRecord("context", (record) => {
    const pins = record?.pins || [];
    if (pins.length >= 24 || pins.reduce((n, p) => n + (p.content?.length || 0), 0) + content.length > 64000) throw new Error("固定上下文已达到容量限制");
    pins.push({ ...pin, content, id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, enabled: true, captured_at: Date.now() });
    return { pins };
  });
}
export async function pinFile(path, range = null, symbol = null) {
  const project = projectKey(), file = await runtime.files.read({ path });
  if (project !== projectKey()) throw new Error("项目已切换");
  if (file.binary) throw new Error("二进制文件不能作为文本上下文");
  const lines = file.content.split("\n");
  return pinContext({ kind: symbol ? "symbol" : "file", path, range, label: symbol || path, revision: file.revision, source: "workspace", content: range ? lines.slice(range[0] - 1, range[1]).join("\n") : file.content });
}
export async function pinActive() {
  const tab = activeTab();
  if (!tab) throw new Error("请先打开文件");
  if (tab.dirty || tab.virtual) return pinContext({ kind: "file", path: tab.virtual ? null : tab.path, label: `${tab.path}（编辑器草稿）`, revision: tab.revision, source: "unsaved_editor", content: tab.text });
  return pinFile(tab.path);
}

let generation = 0;
export function cancelIndex() { generation++; }
const excluded = new Set([".git", ".diffusion", ".koide", "node_modules", "target", "vendor", "dist", "build", ".venv", "venv", "__pycache__", ".gradle"]);
export async function buildIndex(progress = () => {}) {
  const own = ++generation, project = projectKey();
  const { indexSource, linkProject } = await import("../../vendor/cm6.js");
  const queue = ["."], units = [], revisions = {}, skipped = [], failures = [];
  let bytes = 0, visited = 0, truncated = false;
  const current = () => { if (own !== generation || project !== projectKey()) throw new Error("索引已取消或项目已切换"); };
  while (queue.length && units.length < 400 && visited < 400 && bytes < 12_000_000) {
    current(); const dir = queue.shift(); visited++;
    const result = await runtime.files.tree({ path: dir, depth: 1, show_hidden: false }); current();
    const nodes = Array.isArray(result) ? result : result.nodes;
    if (!Array.isArray(nodes)) throw new Error("目录响应无效");
    for (const item of nodes) {
      current();
      if (item.type === "dir") { if (!excluded.has(item.name)) queue.push(item.path); continue; }
      if (!/\.(?:[cm]?[jt]sx?|py|rs|css|html?)$/i.test(item.path)) { skipped.push(item.path); continue; }
      if (units.length >= 400 || bytes >= 12_000_000) { truncated = true; break; }
      try {
        const read = await runtime.files.read({ path: item.path }); current();
        if (read.binary || read.content.length > 500000) { skipped.push(item.path); continue; }
        bytes += read.content.length; revisions[item.path] = read.revision;
        units.push(await indexSource(item.path, read.content)); current(); progress({ files: units.length, path: item.path });
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (e) { current(); failures.push({ path: item.path, error: e.message }); }
    }
  }
  current();
  let index = { ...linkProject(units), revisions, created_at: Date.now() };
  while (new TextEncoder().encode(JSON.stringify(index)).length > 7500000 && units.length > 1) {
    const removed = units.pop(); delete revisions[removed.path]; skipped.push(removed.path); truncated = true;
    index = { ...linkProject(units), revisions, created_at: Date.now() };
  }
  index.coverage = { ...index.coverage, truncated: truncated || queue.length > 0, skipped: skipped.length, failures };
  await changeRecord("index", () => index);
  return index;
}

/** Execution is derived exclusively from tool events, never an LLM status flag. */
export function executionGraph(task, running = false) {
  const events = task.events || [], plans = events.filter((e) => e.type === "plan"), plan = plans.at(-1);
  const starts = events.filter((e) => e.type === "tool_started"), results = events.filter((e) => e.type === "tool_result");
  const actual = starts.map((e) => ({ ...e, result: results.find((r) => r.call_id === e.call_id) }));
  const nodes = (plan?.record?.nodes || []).map((node) => {
    const calls = actual.filter((c) => c.seq > plan.seq && c.arguments?.plan_node_id === node.id);
    const matching = calls.filter((c) => node.kind === "validate" ? c.tool === "shell_run" && (!node.command || c.arguments?.command === node.command) : node.kind === "edit" ? /^fs_(write|patch|create|delete|rename|copy)$/.test(c.tool) : node.kind === "delegate" ? c.tool === "delegate_tasks" : /^(fs_(read|list|search|glob|multi_read)|project_query|web_fetch)$/.test(c.tool));
    const seenPaths = new Set(matching.flatMap((c) => [c.arguments?.path, c.arguments?.from, c.arguments?.to, ...(c.arguments?.paths || [])]).filter(Boolean));
    const covered = !(node.paths || []).length || (node.paths || []).every((p) => seenPaths.has(p));
    const failed = calls.some((c) => c.result && c.result.state !== "done");
    const pending = calls.some((c) => !c.result);
    return { ...node, calls, status: failed ? "failed" : pending ? running ? "running" : "interrupted" : matching.length && covered ? "completed" : calls.length ? "partial" : running ? "planned" : "skipped" };
  });
  return { nodes, actual, plans, replaced: plans.slice(0, -1), unplanned: actual.filter((c) => !plan || c.seq < plan.seq || !nodes.some((n) => n.id === c.arguments?.plan_node_id)) };
}
export function actionRationale(task, event) {
  const plan = (task.events || []).filter((e) => e.type === "plan" && e.seq < event.seq).at(-1);
  const node = plan?.record?.nodes?.find((n) => n.id === event.arguments?.plan_node_id);
  const changes = (task.events || []).filter((e) => e.call_id === event.call_id && e.type === "edit");
  return { goal: task.goal, proposed_reason: node?.rationale || null, plan: node?.title || null, action: event.tool || event.title,
    paths: [...new Set([event.arguments?.path, event.arguments?.from, event.arguments?.to, ...changes.map((e) => e.path)].filter(Boolean))],
    command: event.arguments?.command, state: event.state, evidence: changes.map((e) => e.seq), result: event.summary || event.detail || event.result_excerpt || "该动作尚无返回结果" };
}
