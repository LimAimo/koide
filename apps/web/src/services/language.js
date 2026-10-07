import { runtime, state, events } from "./app.js";
import { addIssue, getProjectEpoch, assertProjectEpoch, studioState } from "./studio.js";
let worker, seq = 0;
const pending = new Map();
function stopWorker(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear(); worker?.terminate(); worker = null;
}
export async function languageRequest(operation, { path = state.get().active, position = 0, new_name } = {}) {
  if (!state.get().workspace) throw new Error("先打开项目再使用语言服务");
  const generation = getProjectEpoch();
  const checkWorkspace = () => assertProjectEpoch(generation);
  if (!worker) {
    worker = new Worker(new URL("../../vendor/language.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); clearTimeout(p.timer); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); };
    worker.onerror = () => stopWorker("语言引擎加载失败，请重新构建应用");
  }
  const paths = [], folders = ["."], visited = new Set(), skip = new Set(["node_modules", "vendor", "dist", "build", "target", ".koide", ".git", ".venv", ".next", "coverage"]);
  // 执行端树深度各不相同，逐层读取避免深层模块在 Native 中被截断。
  while (folders.length) {
    const folder = folders.shift(); if (visited.has(folder)) continue; visited.add(folder);
    if (visited.size > 3000) throw new Error("项目目录超过 3000 个，请缩小语言分析工作区");
    const tree = await runtime.files.tree({ path: folder, depth: 1, show_hidden: false }); checkWorkspace();
    for (const n of tree.nodes || tree.entries || tree.tree || (Array.isArray(tree) ? tree : [])) {
      if (n.type === "dir") { if (!skip.has(n.name)) folders.push(n.path); }
      else if (/\.(?:[cm]?[jt]sx?|d\.ts)$/.test(n.path)) paths.push(n.path);
    }
    if (paths.length > 1000) throw new Error("项目 JS / TS 文件超过 1000 个，请拆分工作区");
  }
  const files = []; let total = 0;
  for (const file of paths) {
    const r = await runtime.files.read({ path: file }); checkWorkspace(); if (r.binary) continue;
    const tab = state.get().tabs.find((t) => t.path === file), content = tab?.dirty ? tab.text : r.content;
    total += content.length; if (total > 12 * 1024 * 1024) throw new Error("语言分析文本超过 12 MiB，请缩小项目范围");
    files.push({ path: file, content, revision: r.revision, dirty: !!tab?.dirty });
  }
  checkWorkspace();
  const id = ++seq;
  const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => stopWorker("语言分析超时，任务已取消"), 25000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, operation, path, position, new_name, files }); });
  checkWorkspace();
  if (operation === "diagnostics") { for (const issue of result.issues) addIssue(issue); events.emit("editor:diagnostics", result.issues); }
  if (operation === "rename") {
    if (result.files.some((f) => files.find((x) => x.path === f.path)?.dirty || state.get().tabs.find((t) => t.path === f.path)?.dirty)) throw new Error("重命名涉及未保存文件，请先保存这些修改");
    for (const f of result.files) { const r = await runtime.files.read({ path: f.path }); checkWorkspace(); if (r.revision !== f.revision) throw new Error(`文件 ${f.path} 已变化，请重新分析`); let content = r.content; for (const e of f.edits) content = content.slice(0, e.from) + e.insert + content.slice(e.to); f.content = content; }
    checkWorkspace();
    await runtime.studio.applyEdits({ files: result.files.map(({ path, revision, content }) => ({ path, revision, content })), label: `重命名为 ${new_name}`, workspace_key: studioState.get().workspaceKey });
    checkWorkspace();
  }
  return result;
}
