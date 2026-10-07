// Real interactive PTY terminal. The same surface can live in a mobile sheet or the desktop IDE dock.
// Sessions are owned by the Bridge, so closing/hiding the UI never kills a running terminal implicitly.

import { h, icon, clear, toast } from "./dom.js";
import { openSheet } from "./overlays.js";
import { TermScreen } from "./ansi.js";
import { openLegacyTerminal } from "./welcome.js";
import { runtime } from "../services/app.js";

const KEYS = [["Ctrl+C", "\x03"], ["Ctrl+D", "\x04"], ["Tab", "\t"], ["Esc", "\x1b"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["⌫", "\x7f"], ["Ctrl+L", "\x0c"]];

function createTerminalSurface({ onNoPty } = {}) {
  const sessions = new Map();
  let current = null, raf = 0, resizeFrame = 0, started = false, destroyed = false;
  const lastSizes = new Map();
  const tabs = h("div", { class: "term-tabs", role: "tablist", "aria-label": "终端会话" });
  const out = h("div", { class: "term-out term-screen", role: "log", "aria-live": "off" });
  const input = h("input", { class: "text-field", type: "text", autocapitalize: "off", autocomplete: "off", spellcheck: "false", enterkeyhint: "send", placeholder: "输入命令，回车执行", "aria-label": "终端输入" });
  const rawBox = h("input", { type: "checkbox", role: "switch", "aria-label": "直接输入模式" });
  const raw = h("label", { class: "switch small" }, rawBox, h("span", { class: "track" }), h("span", { class: "thumb" }));
  const send = (data) => { if (current) runtime.terminal.input({ id: current, data }).catch((e) => toast(e.message)); };
  const keys = h("div", { class: "term-keys" }, KEYS.map(([label, seq]) => {
    const b = h("button", { type: "button" }, label);
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => send(seq));
    return b;
  }));

  function scheduleRender() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const s = sessions.get(current);
      if (!s) return;
      const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      s.screen.render(out);
      if (stick) out.scrollTop = out.scrollHeight;
    });
  }
  function paintTabs() {
    clear(tabs);
    let n = 0;
    for (const s of sessions.values()) {
      n++;
      tabs.appendChild(h("div", { class: "ttab" + (s.id === current ? " on" : "") + (s.alive ? "" : " dead"), role: "tab", "aria-selected": String(s.id === current) },
        h("button", { type: "button", onclick: () => { current = s.id; paintTabs(); scheduleRender(); onResize(); } }, `终端 ${n}`),
        h("button", { class: "x", type: "button", "aria-label": "关闭这个终端", onclick: () => closeSession(s.id) }, icon("close", 14))));
    }
    tabs.appendChild(h("button", { class: "icon-btn", type: "button", "aria-label": "新建终端", onclick: () => newSession() }, icon("add", 18)));
  }
  const size = () => {
    const probe = h("span", { style: { position: "absolute", visibility: "hidden", whiteSpace: "pre", font: "inherit" } }, "0000000000");
    out.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 10 || 8;
    probe.remove();
    return { cols: Math.max(20, Math.floor(((out.clientWidth || 640) - 20) / cw)) || 80, rows: Math.max(8, Math.floor((out.clientHeight || 300) / 18)) || 24 };
  };
  async function newSession() {
    if (destroyed) return;
    try {
      const r = await runtime.terminal.open(size());
      if (destroyed) return; // 终端会话仍由运行时持有，关闭界面不隐式结束进程。
      sessions.set(r.id, { id: r.id, screen: new TermScreen(), alive: true });
      current = r.id;
      paintTabs(); scheduleRender(); onResize();
    } catch (e) {
      if (destroyed) return;
      if (e.code === "NO_PTY") onNoPty?.();
      else toast(e.message);
    }
  }
  async function closeSession(id) {
    await runtime.terminal.close({ id }).catch(() => {});
    if (destroyed) return;
    lastSizes.delete(id);
    sessions.delete(id);
    if (current === id) current = [...sessions.keys()].pop() || null;
    if (!sessions.size) newSession(); else { paintTabs(); scheduleRender(); }
  }

  const offs = [
    runtime.on("terminal.data", (d) => { const s = sessions.get(d.id); if (s) { s.screen.write(d.data); if (d.id === current) scheduleRender(); } }),
    runtime.on("terminal.closed", (d) => { const s = sessions.get(d.id); if (s) { s.alive = false; s.screen.write(`\r\n[进程已退出，退出码 ${d.exit_code}]\r\n`); paintTabs(); if (d.id === current) scheduleRender(); } }),
  ];
  const onResize = () => {
    if (destroyed || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (!current || destroyed || !out.clientWidth || !out.clientHeight) return;
      const id = current, { cols, rows } = size(), key = `${cols}:${rows}`;
      if (lastSizes.get(id) === key) return;
      lastSizes.set(id, key);
      runtime.terminal.resize({ id, cols, rows }).catch(() => { if (lastSizes.get(id) === key) lastSizes.delete(id); });
    });
  };
  window.addEventListener("resize", onResize);
  const observer = globalThis.ResizeObserver ? new ResizeObserver(onResize) : null;
  observer?.observe(out);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !rawBox.checked) { e.preventDefault(); send(input.value + "\r"); input.value = ""; } else if (e.key === "Enter") { e.preventDefault(); send("\r"); } });
  input.addEventListener("input", () => { if (rawBox.checked && input.value) { send(input.value); input.value = ""; } });

  const portsBtn = h("button", { class: "btn text small", type: "button", onclick: async () => {
    try {
      const { ports } = await runtime.ports.list();
      openSheet({ title: "正在监听的端口", body: h("div", { class: "menu" }, ports.length ? ports.map((p) => h("div", { class: "menu-item" }, icon("terminal", 18), h("span", null, `端口 ${p.port}`), h("span", { class: "muted" }, p.family))) : h("p", { class: "muted", style: { padding: "12px" } }, "没有检测到监听中的端口（安卓系统可能不允许读取）。")) });
    } catch (e) { toast(e.message); }
  } }, "端口");

  const el = h("div", { class: "term" }, tabs, out, keys, h("div", { class: "term-in" }, input, h("label", { class: "rawlbl" }, raw, h("span", { class: "muted" }, "直接输入")), portsBtn));

  async function start() {
    if (started || destroyed) return;
    started = true;
    try {
      const { sessions: list } = await runtime.terminal.list();
      if (destroyed) return;
      for (const s of list.filter((x) => x.alive)) {
        const hist = await runtime.terminal.history({ id: s.id });
        if (destroyed) return;
        const screen = new TermScreen();
        screen.write(hist.data);
        sessions.set(s.id, { id: s.id, screen, alive: true });
        current = s.id;
      }
    } catch { /* no old sessions */ }
    if (destroyed) return;
    if (!sessions.size) await newSession(); else { paintTabs(); scheduleRender(); }
    requestAnimationFrame(() => onResize());
  }
  function focus() { setTimeout(() => { if (!destroyed && input.isConnected && input.getBoundingClientRect().width) input.focus(); }, 40); }
  function destroy() {
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    offs.forEach((f) => f());
    window.removeEventListener("resize", onResize);
  }
  return { el, start, focus, destroy };
}

export function openTerminal() {
  let sheet;
  const surface = createTerminalSurface({ onNoPty: () => {
    sheet?.close();
    setTimeout(() => { toast("这个系统不支持交互式终端，已切换为一次性命令模式"); openLegacyTerminal(); }, 300);
  } });
  sheet = openSheet({ title: "终端", tall: true, onClose: surface.destroy, body: surface.el });
  surface.start().then(() => setTimeout(surface.focus, 300));
  return sheet;
}

export function createTerminalDock({ onClose } = {}) {
  let surface = null, visible = false;
  const body = h("div", { class: "terminal-dock-body" });
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "隐藏终端", title: "隐藏终端", onclick: () => onClose?.() }, icon("close", 18));
  const el = h("section", { class: "terminal-dock", hidden: true, "aria-label": "终端" },
    h("div", { class: "terminal-dock-head" }, h("span", null, "终端"), h("span", { class: "spacer" }), close), body);
  function ensure() {
    if (surface) return surface;
    surface = createTerminalSurface({ onNoPty: () => { toast("这个系统不支持交互式终端"); onClose?.(); } });
    body.appendChild(surface.el);
    return surface;
  }
  function show() {
    if (visible) return;
    visible = true;
    el.hidden = false;
    const s = ensure();
    s.start().then(() => s.focus());
  }
  function hide() { visible = false; el.hidden = true; }
  function destroy() { visible = false; surface?.destroy(); }
  return { el, show, hide, destroy };
}
