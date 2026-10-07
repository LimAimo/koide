// 编辑器面板：标签页 + 冲突提示 + 查找栏 + 编辑器（可分屏）。
// 只通过「编辑器适配器接口」使用编辑器，所以内置编辑器和 CodeMirror 6 可以随时互换；分屏时两个窗格各有一个编辑器实例。

import { h, icon, iconButton, toast } from "./dom.js";
import { openMenu, openSheet, promptDialog } from "./overlays.js";
import { createCodingToolbar } from "./coding-toolbar.js";
import { renderMarkdown } from "./markdown.js";
import { loadCM6 } from "../services/editor-factory.js";
import { settingsStore, reducedMotion } from "../services/store.js";
import {
  state, events, getWorkspaceEpoch, tabOf, activeTab, activate, closeTab, closeOthers, closeRight, togglePin, moveTab, updateText, saveTab, resolveConflict,
} from "../services/app.js";

const base = (p) => p.split("/").pop();

export function createEditorPane() {
  const scrollMemory = new Map();
  let shownPath = null;            // 主窗格显示的文件
  let splitPath = null;            // 分屏窗格显示的文件
  let toolbar = null;
  let focused = null;              // 最近获得焦点的编辑器：符号栏、查找栏、保存都作用在它上面
  let origin = null;               // 正在把用户输入同步出去的窗格（"main" | "split"），用来同步同一文件的另一个窗格
  let cm6 = null;                  // CodeMirror 6 工厂；加载失败会显示明确错误，不会回退到 textarea
  let mdPreviewMode = false;

  const optsFor = (which) => ({
    onChange: (text) => { const p = which === "main" ? shownPath : splitPath; if (p) { origin = which; updateText(p, text); origin = null; } },
    onSave: () => save(which === "main" ? shownPath : splitPath),
    onSuggest: (words, pick) => toolbar && toolbar.setSuggestions(words, pick),
    onFind: () => openFind(),
    onFocus: () => { focused = which === "main" ? editor : splitEditor; if (toolbar) toolbar.show(); },
    onBlur: () => toolbar && setTimeout(() => toolbar.hide(), 120),
  });
  function statusEditor(kind, detail = "") {
    let value = "";
    const title = kind === "error" ? "CodeMirror 6 加载失败" : "正在加载 CodeMirror 6…";
    const message = kind === "error"
      ? (detail || "编辑器构建产物不可用。请重新安装依赖并执行 pnpm build:cm6，然后重新打开 Diffusion。")
      : "编辑器正在初始化。";
    const el = h("div", { class: `editor-empty cm6-status ${kind}`, role: kind === "error" ? "alert" : "status" },
      h("div", null, h("h2", null, title), h("p", null, message)));
    return {
      el, isCM6: false, isPlaceholder: true,
      setDocument: ({ text = "" } = {}) => { value = text; }, getValue: () => value, getSelectionText: () => "",
      getScroll: () => ({ top: 0, left: 0 }), setScroll: () => {}, focus: () => {}, revealOffset: () => {},
      insertText: () => {}, indent: () => {}, moveCaret: () => {}, applySettings: () => {}, cancelAnimation: () => {},
      applyExternal: async (after) => { value = String(after ?? ""); }, countMatches: () => 0,
      find: () => null, replaceCurrent: () => null, replaceAll: () => 0, clearFind: () => {},
      destroy: () => el.remove(),
    };
  }
  const makeEditor = (which) => cm6
    ? cm6({ ...optsFor(which), getSettings: () => settingsStore.get(), isReducedMotion: () => reducedMotion() })
    : statusEditor("loading");
  let editor = makeEditor("main");
  let splitEditor = null;
  const fe = () => focused || editor;
  toolbar = createCodingToolbar(() => fe());

  const strip = h("div", { class: "tab-strip", role: "tablist" });
  const saveBtn = h("button", { class: "btn small tonal", type: "button", style: { margin: "6px 4px", display: "none" }, onclick: () => save() }, "保存");
  const more = iconButton("more", "所有已打开的文件", () => openTabList(), "tabs-more");
  const findBtn = iconButton("search", "查找与替换", () => (findBar.hidden ? openFind() : closeFind()), "tabs-more");
  const splitBtn = iconButton("split", "分屏", () => toggleSplit(), "tabs-more");
  const mdBtn = h("button", { class: "btn small text md-toggle", type: "button", hidden: true, onclick: () => { mdPreviewMode = !mdPreviewMode; paintContent(); } }, "预览");
  const tabs = h("div", { class: "tabs" }, strip, mdBtn, splitBtn, findBtn, saveBtn, more);
  tabs.append(iconButton("branch", "语言服务", () => openMenu("代码导航与检查", [
    { label: "检查 JS / TS 问题", onClick: () => language("diagnostics") },
    { label: "跳转到定义", onClick: () => language("definition") },
    { label: "查找符号引用", onClick: () => language("references") },
    { label: "重命名当前符号", onClick: () => language("rename") },
  ])));
  async function language(operation) {
    const epoch = getWorkspaceEpoch(), path = focused === splitEditor ? splitPath : shownPath, position = fe().getCaretOffset?.() || 0;
    const guard = () => { if (epoch !== getWorkspaceEpoch()) throw new Error("项目已切换，语言操作已取消"); };
    try {
      const { languageRequest } = await import("../services/language.js");
      guard();
      const new_name = operation === "rename" ? await promptDialog({ title: "重命名符号", label: "新名称" }) : undefined;
      if (operation === "rename" && !new_name) return;
      guard();
      const result = await languageRequest(operation, { path, position, new_name });
      guard();
      if (operation === "diagnostics") { events.emit("studio:open", "issues"); toast(`分析完成：${result.issues.length} 项问题`); }
      else if (operation === "rename") toast(`已重命名，修改 ${result.files.length} 个文件；可从时光机恢复`);
      else {
        const list = h("div", null);
        for (const x of result.locations) list.append(h("button", { class: "btn tonal", type: "button", onclick: async () => { try { guard(); const { openFile } = await import("../services/app.js"); guard(); await openFile(x.path); guard(); events.emit("editor:reveal", x); } catch (e) { toast(e.message); } } }, `${x.path}:${x.line}`));
        if (!result.locations.length) list.append(h("p", null, "当前符号没有项目内结果"));
        openSheet({ title: operation === "definition" ? "符号定义" : "符号引用", body: list });
      }
    } catch (e) { toast(e.message); }
  }
  events.on("studio:language", language);
  events.on("studio:attach-selection", async () => {
    const epoch = getWorkspaceEpoch(), path = focused === splitEditor ? splitPath : shownPath;
    const text = fe().getSelectionText();
    if (!text) return toast("先在编辑器里选中一段内容");
    const { studioState } = await import("../services/studio.js");
    if (epoch !== getWorkspaceEpoch()) return toast("项目已切换，旧选区已取消");
    studioState.set((s) => ({ selections: [...s.selections.slice(-7), { path, text }] }));
    toast("选区已加入本轮上下文");
  });
  events.on("editor:reveal", ({ path, offset }) => { if (path === shownPath) editor.revealOffset(offset); });
  const banner = h("div", { class: "banner", role: "alert", hidden: true });
  const empty = h("div", { class: "editor-empty" }, h("div", null, h("h2", null, "还没有打开文件"), h("p", null, "从左侧文件树里选一个文件，或者让 AI 改点什么，看着代码自己重新排列。")));
  const binary = h("div", { class: "editor-empty", hidden: true }, h("div", null, h("h2", null, "二进制文件"), h("p", null, "这个文件无法以文本形式显示。")));

  // ---- 查找与替换栏（作用在最近获得焦点的窗格）-----------------------------------------------------------------------------
  const fInput = h("input", { class: "text-field", type: "search", placeholder: "查找", "aria-label": "查找内容", autocapitalize: "off" });
  const rInput = h("input", { class: "text-field", type: "text", placeholder: "替换为", "aria-label": "替换内容", autocapitalize: "off" });
  const countEl = h("span", { class: "muted fcount" });
  let cs = false;
  const show = (r) => { countEl.textContent = r ? `${r.index}/${r.count}` : "无结果"; };
  const run = (backwards = false) => { const q = fInput.value; if (!q) { countEl.textContent = ""; fe().clearFind(); return; } show(fe().find(q, { caseSensitive: cs, backwards })); };
  const csBtn = h("button", { class: "btn small text", type: "button", "aria-pressed": "false", "aria-label": "区分大小写", onclick: () => { cs = !cs; csBtn.setAttribute("aria-pressed", String(cs)); run(); } }, "Aa");
  fInput.addEventListener("input", () => run());
  fInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(e.shiftKey); } else if (e.key === "Escape") closeFind(); });
  const findBar = h("div", { class: "findbar", hidden: true, role: "search" },
    h("div", { class: "frow2" }, fInput, countEl, iconButton("back", "上一个", () => run(true)), iconButton("chevron", "下一个", () => run(false)), csBtn, iconButton("close", "关闭查找", () => closeFind())),
    h("div", { class: "frow2" }, rInput,
      h("button", { class: "btn small tonal", type: "button", onclick: () => show(fe().replaceCurrent(fInput.value, rInput.value, cs)) }, "替换"),
      h("button", { class: "btn small tonal", type: "button", onclick: () => { const n = fe().replaceAll(fInput.value, rInput.value, cs); countEl.textContent = ""; toast(`已替换 ${n} 处`); } }, "全部替换")));
  function openFind() {
    findBar.hidden = false;
    const sel = fe().getSelectionText();
    if (sel && !sel.includes("\n")) fInput.value = sel;
    fInput.focus();
    run();
  }
  function closeFind() { findBar.hidden = true; fe().clearFind(); fe().focus(); }

  // ---- 窗格布局：主窗格 +（可选的）分屏窗格 -----------------------------------------------------------------------------------
  const mdPreview = h("article", { class: "md-preview", hidden: true, "aria-label": "Markdown 预览" });
  const mainPane = h("div", { class: "epane" }, editor.el, mdPreview);
  const editors = h("div", { class: "editors" }, mainPane);
  const el = h("main", { class: "editor-pane" }, tabs, findBar, banner, empty, binary, editors);

  const splitName = h("span", { class: "sname" });
  const splitHead = h("div", { class: "split-head" }, splitName, h("div", { class: "spacer" }), iconButton("close", "关闭分屏", () => closeSplit()));
  let splitWrap = null;

  function openSplit(path) {
    const t = tabOf(path);
    if (!t || t.binary) return;
    if (!splitEditor) {
      splitEditor = makeEditor("split");
      splitWrap = h("div", { class: "epane split" }, splitHead, splitEditor.el);
      editors.appendChild(splitWrap);
    }
    editors.classList.toggle("v", el.getBoundingClientRect().width < 700);        // 窄屏上下分，宽屏左右分
    splitPath = path;
    splitName.textContent = base(path);
    splitEditor.setDocument({ path, text: t.text });
  }
  function closeSplit() {
    if (!splitEditor) return;
    if (focused === splitEditor) focused = null;
    splitEditor.destroy();
    splitWrap.remove();
    splitEditor = null; splitWrap = null; splitPath = null;
  }
  function toggleSplit() {
    if (splitEditor) return closeSplit();
    const s = state.get();
    const other = s.tabs.find((t) => t.path !== s.active && !t.binary);
    const p = (other && other.path) || s.active;
    if (p) openSplit(p); else toast("请先打开一个文件");
  }

  async function save(path) {
    const p = path || (fe() === splitEditor && splitPath) || (activeTab() && activeTab().path);
    if (!p) return;
    try {
      const r = await saveTab(p);
      if (r.saved) toast("已保存");
    } catch (e) {
      if (e.code === "CONFLICT") toast("文件在磁盘上已被修改，请选择保留哪个版本。");
      else toast(e.message);
    }
  }

  // ---- tabs ---------------------------------------------------------------------------------------------------
  const tabEls = new Map();

  function tabMenu(t) {
    openMenu(base(t.path), [
      { label: "在分屏中打开", icon: "split", onClick: () => openSplit(t.path) },
      { label: t.pinned ? "取消固定" : "固定", icon: "check", onClick: () => togglePin(t.path) },
      { label: "关闭", icon: "close", onClick: () => closeTab(t.path) },
      { label: "关闭其他", icon: "close", onClick: () => closeOthers(t.path) },
      { label: "关闭右侧", icon: "close", onClick: () => closeRight(t.path) },
      { label: "向左移动", icon: "back", onClick: () => moveTab(t.path, -1) },
      { label: "向右移动", icon: "chevron", onClick: () => moveTab(t.path, 1) },
    ]);
  }

  function makeTab(t) {
    let timer = null, long = false, sx = 0;
    const node = h("div", { class: "tab tab-enter", role: "tab", tabindex: "0", dataset: { path: t.path } },
      h("span", { class: "name" }),
      h("span", { class: "flag" }),
      h("button", { class: "x", type: "button", "aria-label": "关闭标签页" }, icon("close", 16)));
    node.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.path); });
    node.addEventListener("pointerdown", (e) => { long = false; sx = e.clientX; timer = setTimeout(() => { long = true; tabMenu(tabOf(t.path) || t); }, 480); });
    node.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - sx) > 8) clearTimeout(timer); });
    for (const ev of ["pointerup", "pointercancel"]) node.addEventListener(ev, () => clearTimeout(timer));
    node.addEventListener("click", () => { if (long) { long = false; return; } activate(t.path); });
    node.addEventListener("keydown", (e) => { if (e.key === "Enter") activate(t.path); });
    setTimeout(() => node.classList.remove("tab-enter"), 320);
    return node;
  }

  function paintTabs() {
    const s = state.get();
    const seen = new Set();
    let prev = null;
    for (const t of s.tabs) {
      let node = tabEls.get(t.path);
      if (!node) { node = makeTab(t); tabEls.set(t.path, node); }
      seen.add(t.path);
      const ref = prev ? prev.nextSibling : strip.firstChild;
      if (node !== ref) strip.insertBefore(node, ref);
      prev = node;
      node.querySelector(".name").textContent = base(t.path);
      node.title = t.path;
      node.setAttribute("aria-selected", String(t.path === s.active));
      node.classList.toggle("preview", !!t.preview);
      node.classList.toggle("pinned", !!t.pinned);
      const flag = node.querySelector(".flag");
      const want = s.editing[t.path] ? "agent" : t.dirty ? "dirty" : "";
      if (flag.dataset.k !== want) {
        flag.dataset.k = want;
        flag.className = "flag " + (want === "agent" ? "agent-dot" : want === "dirty" ? "dot" : "");
        flag.setAttribute("aria-label", want === "agent" ? "AI 正在修改" : want === "dirty" ? "有未保存的修改" : "");
      }
    }
    for (const [p, node] of tabEls) if (!seen.has(p)) { node.remove(); tabEls.delete(p); }
    const act = tabEls.get(s.active);
    if (act && act.scrollIntoView) act.scrollIntoView({ inline: "nearest", block: "nearest" });
    more.style.display = s.tabs.length > 1 ? "" : "none";
    const t = activeTab();
    saveBtn.style.display = t && t.dirty ? "" : "none";
  }

  function openTabList() {
    const s = state.get();
    const list = h("div", { class: "menu" }, s.tabs.map((t) => h("button", { class: "menu-item", type: "button", onclick: () => { sheet.close(); activate(t.path); } },
      icon("file", 20), h("span", null, t.path + (t.dirty ? " •" : "")))));
    const sheet = openSheet({ title: `已打开 ${s.tabs.length} 个文件`, body: list });
  }

  // ---- content -------------------------------------------------------------------------------------------------
  function paintBanner(t) {
    if (t && t.conflict) {
      banner.hidden = false;
      while (banner.firstChild) banner.removeChild(banner.firstChild);
      banner.append(h("span", null, "你还有未保存的修改，但这个文件在磁盘上已被改动。"),
        h("button", { class: "btn small text", type: "button", onclick: () => resolveConflict(t.path, "theirs").catch((e) => toast(e.message)) }, "使用磁盘上的版本"),
        h("button", { class: "btn small text", type: "button", onclick: () => resolveConflict(t.path, "mine").catch((e) => toast(e.message)) }, "保留我的版本"));
    } else banner.hidden = true;
  }

  function paintContent() {
    const t = activeTab();
    paintBanner(t);
    empty.hidden = !!t || !!splitEditor;
    binary.hidden = !(t && t.binary);
    const isMd = !!(t && !t.binary && /\.(?:md|markdown)$/i.test(t.path));
    mdBtn.hidden = !isMd;
    mdBtn.textContent = mdPreviewMode && isMd ? "编辑" : "预览";
    mdBtn.setAttribute("aria-pressed", String(mdPreviewMode && isMd));
    const previewing = isMd && mdPreviewMode;
    editor.el.hidden = !t || t.binary || previewing;
    mdPreview.hidden = !previewing;
    if (!t || t.binary) { shownPath = null; while (mdPreview.firstChild) mdPreview.removeChild(mdPreview.firstChild); return; }
    if (!isMd) mdPreviewMode = false;
    if (t.path !== shownPath) {
      if (shownPath) scrollMemory.set(shownPath, editor.getScroll());
      shownPath = t.path;
      editor.setDocument({ path: t.path, text: t.text });
      const m = scrollMemory.get(t.path);
      if (m) editor.setScroll(m);
    }
    if (previewing) {
      while (mdPreview.firstChild) mdPreview.removeChild(mdPreview.firstChild); mdPreview.appendChild(renderMarkdown(t.text || ""));
    }
  }

  /** 同一个文件同时显示在两个窗格里时，把用户在一个窗格的输入同步到另一个窗格。AI 的修改不走这里（它们带着动画单独处理）。 */
  function syncEditors() {
    const o = origin;
    if (!o) return;
    const other = o === "main" ? splitEditor : editor, otherPath = o === "main" ? splitPath : shownPath, myPath = o === "main" ? shownPath : splitPath;
    if (!other || !otherPath || otherPath !== myPath) return;
    const t = tabOf(myPath);
    if (t && other.getValue() !== t.text) other.applyExternal(t.text, { animate: false });
  }

  let lastSig = "", lastTabs = null;
  state.subscribe((s) => {
    if (s.tabs !== lastTabs) {
      lastTabs = s.tabs;
      syncEditors();
      if (splitPath && !tabOf(splitPath)) closeSplit();
      if (mdPreviewMode) paintContent();
    }
    const sig = s.active + "|" + s.tabs.map((t) => `${t.path}:${t.dirty ? 1 : 0}:${t.pinned ? 1 : 0}:${t.preview ? 1 : 0}:${t.conflict ? 1 : 0}`).join(",") + "|" + Object.keys(s.editing).join(",");
    if (sig === lastSig) return;
    lastSig = sig;
    paintTabs();
    paintContent();
  });

  // AI 或撤销引起的修改：两个窗格里显示这个文件的，都播放动画
  events.on("editor:external", ({ path, after, animate, reveal }) => {
    if (path === shownPath) { editor.applyExternal(after, { animate, reveal }); if (mdPreviewMode) paintContent(); }
    if (splitEditor && path === splitPath) splitEditor.applyExternal(after, { animate, reveal });
  });
  events.on("editor:replace", ({ path, text }) => {
    if (path === shownPath) { editor.applyExternal(text, { animate: false }); if (mdPreviewMode) paintContent(); }
    if (splitEditor && path === splitPath) splitEditor.applyExternal(text, { animate: false });
  });

  // ---- 正式编辑器：CodeMirror 6 ----------------------------------------------------------------------------------------
  function swapEditor(which, next) {
    const old = which === "main" ? editor : splitEditor;
    old.el.parentNode.insertBefore(next.el, old.el);
    old.destroy();
    if (focused === old) focused = null;
    if (which === "main") { editor = next; shownPath = null; paintContent(); }
    else { splitEditor = next; const t = tabOf(splitPath); if (t) next.setDocument({ path: splitPath, text: t.text }); }
  }
  async function loadRequiredEditor() {
    try {
      cm6 = await loadCM6();
      if (!editor.isCM6) swapEditor("main", makeEditor("main"));
      if (splitEditor && !splitEditor.isCM6) swapEditor("split", makeEditor("split"));
    } catch (error) {
      const detail = error?.message ? `加载错误：${error.message}` : "编辑器构建产物不可用。";
      if (editor.isPlaceholder) swapEditor("main", statusEditor("error", detail));
      if (splitEditor?.isPlaceholder) swapEditor("split", statusEditor("error", detail));
      toast("CodeMirror 6 加载失败，请检查编辑器构建产物");
    }
  }

  paintTabs();
  paintContent();
  loadRequiredEditor();
  return { el, get editor() { return editor; }, get splitEditor() { return splitEditor; }, save, openSplit, closeSplit, toggleSplit };
}
