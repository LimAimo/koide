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
import { hasLayers, openMenu, confirmDialog } from "./components/overlays.js";
import { runtime, state, events, openFile, initConnection, connectManual, goHome, refreshGit, restoreConversation } from "./services/app.js";
import { pairFromLocation } from "./services/pairing.js";
import { settingsStore, saveSettings, applyTheme } from "./services/store.js";
import { loadServedPacks } from "./animations/diffusion/packs.js";
import { installAndroidNativeShell } from "./services/android-native-ui.js";

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
  const tree = createFileTree({ onOpen: (p, o) => openFile(p, o).catch((e) => toast(e.message)), onNavigate: () => layout && layout.closeDrawer() });
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
      })),
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
  const welcome = createWelcome({ onOpenSettings: (sec) => openSettings(sec) });
  const terminalDock = createTerminalDock({ onClose: () => saveSettings({ terminalVisible: false }) });
  const center = h("div", { class: "center-stack" }, editorPane.el, terminalDock.el);
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
  const filesBtn = iconButton("folder", "显示或隐藏文件面板", () => saveSettings({ filesVisible: !settingsStore.get().filesVisible }), "panel-files-toggle");
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
  const bar = h("header", { class: "appbar" },
    homeBtn, iconButton("menu", "文件", () => layout.openDrawer(), "menu-btn"), title, createCapsule(), h("div", { class: "spacer" }),
    filesBtn, aiBtn, gitBtn, tmBtn, termBtn, iconButton("tune", "设置", () => openSettings()));
  app.append(bar, work, scrim);
  document.body.appendChild(app);

  layout = setupLayout({
    app, files, ai: chat.el, grip, scrim, resizers: { r1, r2 },
    onCloseAI: () => { if (settingsStore.get().aiVisible) saveSettings({ aiVisible: false }); },
  });

  installAndroidNativeShell({
    onFiles: () => layout.openDrawer(),
    onAI: () => {
      const show = !settingsStore.get().aiVisible;
      saveSettings({ aiVisible: show });
      if (show) requestAnimationFrame(() => layout.openSheetHalf());
      else layout.closeSheet();
    },
    onSettings: () => openSettings(),
  });

  state.subscribe((s) => {
    const ws = s.workspace;
    title.textContent = ws ? ws.name : "Koide";
    filesName.textContent = ws ? ws.name : "Files";
    app.classList.toggle("no-ws", !ws);
    homeBtn.hidden = !ws && !s.tabs.length;                          // 项目里或草稿本里都能一键回到首页
    aiBtn.hidden = tmBtn.hidden = termBtn.hidden = gitBtn.hidden = !ws;   // 首页还没有项目，这些按钮没有意义，直接隐藏而不是灰掉
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
      // 每次进入项目都从安静的编辑器开始；AI 由用户点击顶部按钮后以半屏打开。
      if (settingsStore.get().aiVisible) saveSettings({ aiVisible: false });
      tree.reset(); events.emit("conversation:load", null); restoreConversation(); refreshGit();
    }
  });

  // Android back: if nothing is layered on top, the browser leaves the app as usual.
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && hasLayers()) history.back(); });

  const paintPanels = (s) => {
    app.classList.toggle("files-hidden", !s.filesVisible);
    app.classList.toggle("ai-hidden", !s.aiVisible);
    filesBtn.classList.toggle("active", !!s.filesVisible);
    aiBtn.classList.toggle("active", !!s.aiVisible);
    filesBtn.setAttribute("aria-pressed", String(!!s.filesVisible));
    aiBtn.setAttribute("aria-pressed", String(!!s.aiVisible));
    const ws = state.get().workspace;
    const termShown = !!s.terminalVisible && layout?.mode === "wide" && !!ws && ws?.capabilities?.terminal_cwd !== false;
    app.classList.toggle("terminal-open", termShown);
    termBtn.classList.toggle("active", termShown);
    termBtn.setAttribute("aria-pressed", String(termShown));
    termShown ? terminalDock.show() : terminalDock.hide();
  };
  settingsStore.subscribe(paintPanels);
  state.subscribe(() => paintPanels(settingsStore.get()));
  window.addEventListener("resize", () => requestAnimationFrame(() => paintPanels(settingsStore.get())));
  paintPanels(settingsStore.get());

  loadServedPacks();
  (async () => {                                                      // 地址里带着 #pair=配对码 时（扫码打开），自动完成配对
    try {
      if (await pairFromLocation(location, connectManual)) { history.replaceState(null, "", location.pathname + (location.search || "")); toast("已配对并连接"); return; }
    } catch (e) { toast(`配对失败：${e.message}`); }
    await initConnection();                                           // 失败时静默留在网页模式，状态胶囊会显示结果
  })();

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline shell is a bonus */ });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
