// Koide entry point.

import { h, icon, iconButton, toast } from "./components/dom.js";
import { createCapsule } from "./components/status-capsule.js";
import { createFileTree } from "./components/file-tree.js";
import { createEditorPane } from "./components/editor-pane.js";
import { createChat } from "./components/chat.js";
import { createWelcome, openFolderPicker } from "./components/welcome.js";
import { openTerminal, createTerminalDock } from "./components/terminal.js";
import { openGitPanel } from "./components/git-panel.js";
import { importFiles, exportPath } from "./components/transfer.js";
import { openSettings } from "./components/settings.js";
import { openTimeMachine } from "./components/timeline.js";
import { setupLayout } from "./components/layout.js";
import { hasLayers, openMenu, openSheet, confirmDialog, configureSurfaces, dismissPageSurfaces } from "./components/overlays.js";
import { runtime, state, events, openFile, initConnection, connectManual, goHome, refreshGit, restoreConversation } from "./services/app.js";
import { pairFromLocation } from "./services/pairing.js";
import { settingsStore, saveSettings, applyTheme } from "./services/store.js";
import { loadServedPacks } from "./animations/diffusion/packs.js";
import { createWorkbench } from "./components/workbench.js";
import { createAmbience } from "./components/ambience.js";
import { projectStore, studioState, getProjectEpoch, assertProjectEpoch } from "./services/studio.js";

// Native shells should behave like apps, not zoomable web pages.
if (runtime.kind === "native") {
  document.addEventListener("touchmove", (event) => {
    if (event.touches?.length > 1) event.preventDefault();
  }, { passive: false });
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
}

function boot() {
  applyTheme();
  settingsStore.subscribe(applyTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme());

  const app = h("div", { id: "app" });
  const scrim = h("div", { class: "drawer-scrim" });
  let layout;

  // ---- files ---------------------------------------------------------------------------------------------------
  const tree = createFileTree({ onOpen: (p, o) => { dismissPageSurfaces(); events.emit("editor:reveal", { path: p, offset: 0 }); return openFile(p, o).catch((e) => toast(e.message)); }, onNavigate: () => layout && layout.closeDrawer() });
  const filesName = h("span", { class: "name" }, "文件");
  const files = h("aside", { class: "files", "aria-label": "文件" },
    h("div", { class: "files-head" }, filesName,
      iconButton("add", "新建文件或文件夹", () => tree.create()),
      iconButton("more", "更多操作", () => {
        const st = settingsStore.get();
        openMenu("项目", [
          { label: "打开其他文件夹", icon: "folder", onClick: () => openFolderPicker() },
          { label: "导入文件到项目根目录…", icon: "upload", onClick: () => importFiles(".") },
          { label: "导出整个项目为 zip", icon: "download", onClick: () => exportPath(".") },
          { label: st.showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件（含 .git）", icon: "file", onClick: () => saveSettings({ showHiddenFiles: !st.showHiddenFiles }) },
          { label: "从最近项目移除", icon: "trash", danger: true, onClick: async () => {
            const ws = state.get().workspace;
            const location = ws?.location || (ws?.roots?.[0] ? ws.roots[0] : null);
            if (!location) return;
            const params = typeof location === "string" ? { path: location } : { location };
            try { await runtime.workspace.removeRecent(params); toast("已从最近项目移除，不会删除任何文件"); } catch (e) { toast(e.message); }
          } },
          { label: "关闭项目，返回首页", icon: "home", onClick: () => backHome() },
        ]);
      }), iconButton("close", "关闭文件侧栏", () => layout?.closeDrawer(), "files-close")),
    tree.el);

  // ---- centre + AI -------------------------------------------------------------------------------------------------
  const editorPane = createEditorPane();
  const grip = h("div", { class: "grip", role: "separator", "aria-label": "调整 AI 面板高度", "aria-orientation": "horizontal" }, h("span"));
  const chat = createChat({
    onNeedExpand: () => { if (!settingsStore.get().aiVisible) saveSettings({ aiVisible: true }); if (layout) layout.expandSheet(0.5); },   // 需要你审批时，即使面板被关掉也会自动弹出
    onOpenTimeline: (id) => openTimeMachine(id),
    onOpenProviders: () => openSettings("providers"),
  });
  chat.el.insertBefore(grip, chat.el.firstChild);
  const r1 = h("div", { class: "resizer r1", role: "separator", tabindex: "0", "aria-label": "调整文件面板宽度" });
  const r2 = h("div", { class: "resizer r2", role: "separator", tabindex: "0", "aria-label": "调整 AI 面板宽度" });
  const r3 = h("div", { class: "resizer r3", role: "separator", tabindex: "0", "aria-label": "调整终端高度", "aria-orientation": "horizontal" });
  const welcome = createWelcome({ onOpenSettings: (sec) => openSettings(sec) });
  const terminalDock = createTerminalDock({ onClose: () => saveSettings({ terminalVisible: false }) });
  let workbenchSurface = null;
  const hideWorkbench = () => { workbenchSurface?.close(); workbench.hide(); center.classList.remove("studio-workbench-open"); };
  const workbench = createWorkbench({ onClose: hideWorkbench, onOpenTimeline: (id) => openTimeMachine(id) });
  const pageHost = h("div", { class: "workspace-pages", hidden: true, "aria-label": "工作区页面" });
  const center = h("div", { class: "center-stack" }, editorPane.el, workbench.el, pageHost, r3, terminalDock.el);
  configureSurfaces({ app, pageHost });
  const showWorkbench = (tab, anchor) => {
    if (workbenchSurface) { workbench.show(tab); return; }
    if (layout?.device === "phone") center.classList.add("studio-workbench-open");
    else workbenchSurface = openSheet({ title: "创作工作台", presentation: "page", mobileFullscreen: true, anchor, body: workbench.el, onClose: () => {
      workbenchSurface = null; workbench.hide(); center.insertBefore(workbench.el, pageHost); center.classList.remove("studio-workbench-open");
    } });
    workbench.show(tab);
  };
  events.on("studio:open", showWorkbench);
  const ambience = createAmbience({ app, projectStore, state, events, runtime,
    onFocus: (on) => { app.classList.toggle("studio-focus", on); layout?.syncPanels(settingsStore.get()); },
    onTaskPanel: () => showWorkbench("control"),
    onOpenCheckpoint: (id) => openTimeMachine(id),
    getPreview: async () => {
      const epoch = getProjectEpoch();
      const p = studioState.get().preview; if (!p) return null;
      const { data_url } = await runtime.preview.capture({ id: p.id, width: 640, height: 400, workspace_key: studioState.get().workspaceKey || undefined });
      assertProjectEpoch(epoch);
      const image = new Image(); image.src = data_url; await image.decode();
      assertProjectEpoch(epoch);
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 400;
      canvas.getContext("2d").drawImage(image, 0, 0, 640, 400);
      return canvas.toDataURL("image/jpeg", 0.65);
    },
  });
  const work = h("div", { class: "work" }, files, r1, center, r2, chat.el, welcome);
  welcome.style.cssText = "position:absolute;inset:0;z-index:15;background:var(--surface)";

  // ---- top bar ---------------------------------------------------------------------------------------------------------
  const title = h("div", { class: "title" }, "Koide");
  async function backHome() {
    const dirty = state.get().tabs.filter((t) => t.dirty);
    if (dirty.length && !(await confirmDialog({ title: "返回首页？", message: `有 ${dirty.length} 个文件的修改还没保存，返回首页会丢掉这些修改。`, confirmLabel: "仍然返回", danger: true }))) return;
    goHome().catch((e) => toast(e.message));
  }
  const homeBtn = iconButton("home", "返回首页", () => backHome(), "home-btn");
  const filesBtn = iconButton("folder", "显示或隐藏文件面板", (event) => {
    if (layout?.device === "tablet") { if (app.classList.contains("files-open")) layout.closeDrawer(); else layout.openDrawer(event.currentTarget); }
    else saveSettings({ filesVisible: !settingsStore.get().filesVisible });
  }, "panel-files-toggle");
  const aiBtn = iconButton("spark", "显示或隐藏 AI 面板", () => {
    const show = !settingsStore.get().aiVisible;
    saveSettings({ aiVisible: show });
    if (show) requestAnimationFrame(() => layout?.openSheetHalf());
    else layout?.closeSheet();
  }, "ai-toggle");
  const gitBtn = iconButton("branch", "Git", () => openGitPanel());
  const tmBtn = iconButton("history", "时光机", () => openTimeMachine());
  const termBtn = iconButton("terminal", "显示或隐藏终端", () => {
    if (layout?.mode === "wide") saveSettings({ terminalVisible: !settingsStore.get().terminalVisible });
    else openTerminal();
  });
  const workbenchBtn = iconButton("play", "创作工作台", (event) => showWorkbench("task", event.currentTarget));
  const settingsBtn = iconButton("tune", "设置", () => openSettings());
  const menuBtn = iconButton("menu", "文件", (event) => layout.openDrawer(event.currentTarget), "menu-btn");
  for (const button of [homeBtn, filesBtn, menuBtn, gitBtn, tmBtn, termBtn]) button.dataset.surfaceSide = "left";
  for (const button of [aiBtn, workbenchBtn, ambience.button, settingsBtn]) button.dataset.surfaceSide = "right";
  const bar = h("header", { class: "appbar" },
    homeBtn, menuBtn, title, filesBtn, gitBtn, tmBtn, termBtn, h("span", { class: "toolbar-divider", "aria-hidden": "true" }),
    createCapsule(), h("div", { class: "spacer" }), aiBtn, workbenchBtn, ambience.button, settingsBtn);
  app.append(bar, work, scrim);
  document.body.appendChild(app);
  app.append(ambience.el);
  events.on("studio:show-chat", () => { saveSettings({ aiVisible: true }); layout?.expandSheet(0.5); });
  events.on("editor:reveal", hideWorkbench);
  window.__KOIDE_BOOT_OK__ = true;
  document.getElementById("boot-fallback")?.remove();

  layout = setupLayout({
    app, files, ai: chat.el, grip, scrim, terminal: terminalDock.el, resizers: { r1, r2, r3 },
    onCloseAI: () => { if (settingsStore.get().aiVisible) saveSettings({ aiVisible: false }); },
  });


  state.subscribe((s) => {
    const ws = s.workspace;
    title.textContent = ws ? ws.name : "Koide";
    filesName.textContent = ws ? ws.name : "文件";
    app.classList.toggle("no-ws", !ws);
    homeBtn.hidden = !ws && !s.tabs.length;                          // 项目里或草稿本里都能一键回到首页
    aiBtn.hidden = tmBtn.hidden = termBtn.hidden = gitBtn.hidden = !ws;   // 首页还没有项目，这些按钮没有意义，直接隐藏而不是灰掉
    workbenchBtn.hidden = !ws;
    const canGit = ws?.capabilities?.git !== false;
    const canTerminal = ws?.capabilities?.terminal_cwd !== false;
    gitBtn.disabled = !!ws && !canGit;
    termBtn.disabled = !!ws && !canTerminal;
    gitBtn.title = !canGit ? "Android SAF 原地项目不提供 Git；复制到 Koide 私有工作区后可用" : (ws && s.git.is_repo ? `Git：${s.git.branch}` : "Git");
    termBtn.title = !canTerminal ? "Android SAF 原地项目不能把系统终端 cwd 设为该目录；复制到 Koide 私有工作区后可用" : "显示或隐藏终端";
  });
  let lastWs = null;
  state.subscribe((s) => {
    const k = s.workspace ? s.workspace.roots.join("|") : null;
    if (k === lastWs) return;
    const enteringProject = !!k && k !== lastWs;
    lastWs = k;
    if (enteringProject) {
      // 手机进入项目从编辑器开始；桌面沿用用户选择的常驻分栏。
      if (layout?.device !== "desktop" && settingsStore.get().aiVisible) saveSettings({ aiVisible: false });
      hideWorkbench();
      tree.reset(); events.emit("conversation:load", null); restoreConversation(); refreshGit();
    }
  });

  // Android back: if nothing is layered on top, the browser leaves the app as usual.
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && hasLayers()) { e.preventDefault(); history.back(); return; }
    if (layout?.device !== "desktop" || !(e.ctrlKey || e.metaKey) || e.altKey || hasLayers()) return;
    const action = e.key === "," ? settingsBtn : e.key === "1" ? filesBtn : e.key === "2" ? aiBtn : e.code === "Backquote" ? termBtn : null;
    if (action && !action.hidden && !action.disabled) { e.preventDefault(); action.click(); }
  });
  filesBtn.setAttribute("aria-keyshortcuts", "Control+1 Meta+1");
  aiBtn.setAttribute("aria-keyshortcuts", "Control+2 Meta+2");
  termBtn.setAttribute("aria-keyshortcuts", "Control+` Meta+`");
  settingsBtn.setAttribute("aria-keyshortcuts", "Control+, Meta+,");
  filesBtn.title += "（Ctrl/⌘ + 1）"; aiBtn.title += "（Ctrl/⌘ + 2）"; settingsBtn.title += "（Ctrl/⌘ + ,）";

  const paintPanels = (s) => {
    app.classList.toggle("files-hidden", !s.filesVisible);
    app.classList.toggle("ai-hidden", !s.aiVisible);
    filesBtn.classList.toggle("active", !!s.filesVisible);
    aiBtn.classList.toggle("active", !!s.aiVisible);
    filesBtn.setAttribute("aria-pressed", String(!!s.filesVisible));
    aiBtn.setAttribute("aria-pressed", String(!!s.aiVisible));
    const ws = state.get().workspace;
    const termShown = !!s.terminalVisible && layout?.mode === "wide" && !!ws && ws?.capabilities?.terminal_cwd !== false;
    layout?.syncPanels({ filesVisible: !!s.filesVisible, aiVisible: !!s.aiVisible, terminalVisible: termShown });
    if (layout?.device === "tablet") { filesBtn.classList.toggle("active", app.classList.contains("files-open")); filesBtn.setAttribute("aria-pressed", String(app.classList.contains("files-open"))); }
    app.classList.toggle("terminal-open", termShown);
    termBtn.classList.toggle("active", termShown);
    termBtn.setAttribute("aria-pressed", String(termShown));
    termShown ? terminalDock.show() : terminalDock.hide();
  };
  settingsStore.subscribe(paintPanels);
  state.subscribe(() => paintPanels(settingsStore.get()));
  window.addEventListener("resize", () => requestAnimationFrame(() => paintPanels(settingsStore.get())));
  window.addEventListener("koide:layout-resize", () => { if (layout?.device === "tablet") { const open = app.classList.contains("files-open"); filesBtn.classList.toggle("active", open); filesBtn.setAttribute("aria-pressed", String(open)); } });
  paintPanels(settingsStore.get());

  loadServedPacks();
  (async () => {                                                      // 地址里带着 #pair=配对码 时（扫码打开），自动完成配对
    try {
      if (await pairFromLocation(location, connectManual)) { history.replaceState(null, "", location.pathname + (location.search || "")); toast("已配对并连接"); return; }
    } catch (e) { toast(`配对失败：${e.message}`); }
    await initConnection();                                           // 失败时静默留在网页模式，状态胶囊会显示结果
  })();

}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
