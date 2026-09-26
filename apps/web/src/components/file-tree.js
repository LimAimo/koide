// File tree. Rows are reconciled (not re-rendered) so new files grow in, deleted files shrink out, and folders
// expand smoothly. Long-press opens a touch-friendly action sheet.

import { h, icon, toast, debounce } from "./dom.js";
import { openMenu, openDialog, confirmDialog, promptDialog } from "./overlays.js";
import { runtime, events, state } from "../services/app.js";
import { settingsStore } from "../services/store.js";
import { importFiles, exportPath } from "./transfer.js";

const extHue = (name) => {
  const ext = (name.split(".").pop() || "").toLowerCase();
  let n = 0;
  for (const c of ext) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
};
const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const join = (dir, name) => (dir === "." || dir === "" ? name : `${dir}/${name}`);

export function createFileTree({ onOpen, onNavigate }) {
  const el = h("div", { class: "tree", role: "tree", "aria-label": "项目文件" });
  const expanded = new Set();
  const cache = new Map();           // dir path -> nodes
  let selectedPath = null;           // 创建目标跟随最近点选的文件/文件夹
  let lastActive = null;
  const inner = h("div");
  el.appendChild(inner);

  async function load(dir) {
    const res = await runtime.files.tree({ path: dir, depth: 1, show_hidden: !!settingsStore.get().showHiddenFiles });
    cache.set(dir, res.nodes);
    return res.nodes;
  }

  function makeNode(n, depth) {
    const isDir = n.type === "dir";
    const row = h("div", { class: "row", role: "treeitem", tabindex: "0", "aria-expanded": isDir ? "false" : null },
      h("span", { class: "chev" + (isDir ? "" : " none") }, icon("chevron", 18)),
      isDir ? h("span", { class: "fold-ico" }, icon("folder", 18)) : h("span", { class: "ftype", style: { "--ext-h": String(extHue(n.name)) } }),
      h("span", { class: "name" }, n.name));
    const node = h("div", { class: "node", dataset: { path: n.path, type: n.type } }, row);
    row.style.setProperty("--depth", String(depth));
    if (isDir) {
      const kids = h("div", { class: "kids" }, h("div", { class: "inner" }));
      node.appendChild(kids);
    }
    attachGestures(row, n);
    return node;
  }

  function attachGestures(row, n) {
    let timer = null, sx = 0, sy = 0, long = false;
    row.setAttribute("draggable", "true");                                           // 桌面端可直接拖动文件到文件夹
    row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-dfx-path", n.path); e.dataTransfer.effectAllowed = "move"; });
    if (n.type === "dir") {
      row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop"); });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault(); row.classList.remove("drop");
        const from = e.dataTransfer.getData("text/x-dfx-path");
        if (!from || from === n.path || n.path.startsWith(from + "/")) return;
        try { await runtime.files.rename({ from, to: join(n.path, from.split("/").pop()) }); } catch (err) { toast(err.message); }
      });
    }
    const cancel = () => { clearTimeout(timer); timer = null; };
    row.addEventListener("pointerdown", (e) => {
      long = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { long = true; timer = null; navigator.vibrate && navigator.vibrate(12); menuFor(n); }, 450);
    });
    row.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
    row.addEventListener("pointerup", cancel);
    row.addEventListener("pointercancel", cancel);
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); cancel(); menuFor(n); });
    row.addEventListener("click", () => {
      if (long) { long = false; return; }
      selectedPath = n.path;
      paint();
      n.type === "dir" ? toggle(n.path) : onOpen(n.path, { preview: true });
      if (n.type !== "dir") onNavigate && onNavigate();
    });
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); } });
  }

  function reconcile(container, nodes, depth) {
    const existing = new Map();
    for (const c of [...container.children]) if (c.dataset && c.dataset.path) existing.set(c.dataset.path, c);
    let prev = null;
    const keep = new Set();
    for (const n of nodes) {
      let node = existing.get(n.path);
      if (!node || node.classList.contains("exit")) {
        node = makeNode(n, depth);
        node.classList.add("enter");
        setTimeout(() => node.classList.remove("enter"), 320);
      }
      keep.add(n.path);
      const ref = prev ? prev.nextSibling : container.firstChild;
      if (node !== ref) container.insertBefore(node, ref);
      prev = node;
      if (n.type === "dir" && expanded.has(n.path) && cache.has(n.path)) {
        node.classList.add("open");
        node.querySelector(".row").setAttribute("aria-expanded", "true");
        reconcile(node.querySelector(".inner"), cache.get(n.path), depth + 1);
      }
    }
    for (const [p, node] of existing) {
      if (keep.has(p) || node.classList.contains("exit")) continue;
      node.classList.add("exit");
      setTimeout(() => node.remove(), 230);
    }
    if (container === inner && !nodes.length) {
      if (!container.querySelector(".tree-empty")) container.appendChild(h("div", { class: "tree-empty" }, "这个文件夹是空的。"));
    } else if (container === inner) container.querySelector(".tree-empty")?.remove();
  }

  const nodeFor = (path) => [...el.querySelectorAll(".node")].find((n) => n.dataset.path === path);

  async function toggle(path) {
    const node = nodeFor(path);
    if (!node) return;
    if (expanded.has(path)) {
      expanded.delete(path);
      node.classList.remove("open");
      node.querySelector(".row").setAttribute("aria-expanded", "false");
      return;
    }
    expanded.add(path);
    try { await load(path); } catch (e) { toast(e.message); expanded.delete(path); return; }
    const depth = Number(node.querySelector(".row").style.getPropertyValue("--depth")) + 1;
    reconcile(node.querySelector(".inner"), cache.get(path), depth);
    requestAnimationFrame(() => { node.classList.add("open"); node.querySelector(".row").setAttribute("aria-expanded", "true"); });
  }

  async function refresh(dir = null) {
    if (!state.get().workspace) return;
    try {
      const dirs = dir === null ? [".", ...expanded] : [dir];
      for (const d of dirs) { if (d === "." || expanded.has(d)) await load(d); }
      reconcile(inner, cache.get(".") || [], 0);
    } catch (e) { /* workspace may have closed */ }
  }

  async function reset() {
    expanded.clear(); cache.clear();
    while (inner.firstChild) inner.removeChild(inner.firstChild);
    await refresh(".");
  }

  const refreshSoon = debounce((dir) => refresh(dir), 90);
  events.on("tree:refresh", (c) => refreshSoon(c ? parentOf(c.path) : null));

  async function revealPath({ path, scroll = false } = {}) {
    if (!path || !state.get().workspace) return;
    const parts = path.split("/").filter(Boolean);
    const dirs = [];
    for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
    try {
      await load(".");
      for (const dir of dirs) { expanded.add(dir); await load(dir); }
      reconcile(inner, cache.get(".") || [], 0);
      if (scroll) requestAnimationFrame(() => nodeFor(path)?.scrollIntoView?.({ block: "nearest" }));
    } catch { /* workspace may have changed while the agent was working */ }
  }
  events.on("tree:reveal", (d) => revealPath(d));

  // selection + agent-activity indicators follow global state
  function paint() {
    const s = state.get();
    if (s.active !== lastActive) { lastActive = s.active; if (s.active) selectedPath = s.active; }
    const gf = s.git ? s.git.files : {}, gkeys = Object.keys(gf);
    for (const node of el.querySelectorAll(".node")) {
      const p = node.dataset.path, row = node.querySelector(".row");
      node.classList.toggle("selected", p === selectedPath);
      let letter = gf[p];
      if (!letter && node.dataset.type === "dir" && gkeys.some((k) => k.startsWith(p + "/"))) letter = "•";
      let badge = row.querySelector(".git-badge");
      if (letter && !badge) { badge = h("span", { class: "git-badge" }); row.insertBefore(badge, row.querySelector(".ai-dot")); }
      if (badge) { if (letter) { badge.textContent = letter; badge.dataset.l = letter; badge.title = "Git 状态"; } else badge.remove(); }
      const has = row.querySelector(".ai-dot");
      if (s.editing[p] && !has) row.appendChild(h("span", { class: "ai-dot", title: "AI 正在修改", "aria-label": "AI 正在修改这个文件" }));
      else if (!s.editing[p] && has) has.remove();
    }
  }
  state.subscribe(paint);
  let lastShowHidden = !!settingsStore.get().showHiddenFiles;
  settingsStore.subscribe((s) => {
    const next = !!s.showHiddenFiles;
    if (next === lastShowHidden) return;
    lastShowHidden = next;
    reset();
  });

  // ---- actions -------------------------------------------------------------------------------------------------
  const selectedNode = () => selectedPath ? nodeFor(selectedPath) : null;
  const createDir = () => {
    const node = selectedNode();
    if (!node) return ".";
    return node.dataset.type === "dir" ? node.dataset.path : parentOf(node.dataset.path);
  };

  async function createNamed(dir, name, kind) {
    name = String(name || "").trim();
    if (!name) return false;
    if (name.includes("/") || name.includes("\\")) { toast("名称不能包含 / 或 \\"); return false; }
    const path = join(dir, name);
    try {
      await runtime.files.create({ path, kind });
      if (dir !== "." && !expanded.has(dir)) expanded.add(dir);
      await refresh(dir);
      if (kind === "file") onOpen(path, { preview: false });
      selectedPath = path;
      paint();
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  function openCreateDialog(dir = createDir()) {
    const input = h("input", { class: "text-field", type: "text", placeholder: "名称", "aria-label": "名称", autocapitalize: "off", spellcheck: "false" });
    let dialog;
    const run = async (kind) => { if (await createNamed(dir, input.value, kind)) dialog.close(); };
    dialog = openDialog({
      title: "你想要创建...?",
      body: h("label", { class: "field" }, input),
      actions: [
        { label: "取消" },
        { label: "文件", onClick: () => createNamed(dir, input.value, "file") },
        { label: "文件夹", primary: true, onClick: () => createNamed(dir, input.value, "dir") },
      ],
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const name = input.value.trim();
      // Enter 只在明显像文件名时快捷创建文件；普通名称仍让用户明确点「文件」或「文件夹」。
      if (!name || name.startsWith(".") || !/\.[^./\\]+$/.test(name)) return;
      e.preventDefault();
      run("file");
    });
    setTimeout(() => input.focus(), 60);
    return dialog;
  }

  async function createIn(dir, kind) {
    const name = await promptDialog({ title: kind === "dir" ? "新建文件夹" : "新建文件", label: dir === "." ? "名称" : `位于 ${dir}/`, confirmLabel: "创建" });
    if (!name) return;
    await createNamed(dir, name, kind);
  }

  function menuFor(n) {
    const dir = n.type === "dir" ? n.path : parentOf(n.path);
    openMenu(n.name, [
      { label: "在此新建文件", icon: "add", onClick: () => createIn(dir, "file") },
      { label: "在此新建文件夹", icon: "folder", onClick: () => createIn(dir, "dir") },
      { label: "重命名", icon: "edit", onClick: async () => {
        const name = await promptDialog({ title: "重命名", value: n.name, confirmLabel: "重命名" });
        if (!name || name === n.name) return;
        try { await runtime.files.rename({ from: n.path, to: join(parentOf(n.path), name) }); } catch (e) { toast(e.message); }
      } },
      { label: "复制路径", icon: "file", onClick: () => navigator.clipboard?.writeText(n.path).then(() => toast("路径已复制")) },
      { label: "导入文件到这里…", icon: "upload", onClick: () => importFiles(dir) },
      { label: "导出为 zip", icon: "download", onClick: () => exportPath(n.path) },
      { label: "移动到…", icon: "folder", onClick: async () => {
        const d = await promptDialog({ title: "移动到", label: "目标文件夹（相对项目根目录，输入 . 表示根目录）", confirmLabel: "移动" });
        if (!d) return;
        try { await runtime.files.rename({ from: n.path, to: join(d.trim() === "." ? "." : d.trim().replace(/\/+$/, ""), n.name) }); } catch (e) { toast(e.message); }
      } },
      { label: "删除", icon: "trash", danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: `删除 ${n.name}？`, message: "文件会先移到 Diffusion 回收站，之后可以在「设置 › 工作区」里恢复。", confirmLabel: "删除", danger: true }))) return;
        try { await runtime.files.delete({ path: n.path }); toast("已移到 Diffusion 回收站"); } catch (e) { toast(e.message); }
      } },
    ]);
  }

  return { el, refresh, reset, create: () => openCreateDialog(), newFile: () => createIn(".", "file"), newFolder: () => createIn(".", "dir") };
}
