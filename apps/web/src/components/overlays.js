// Overlays. Every overlay registers a layer so Android Back closes them in the right order:
// context menu -> dialog -> bottom sheet -> drawer -> AI fullscreen -> settings page -> (finally) leave the app.

import { h, icon, clear } from "./dom.js";
import { reducedMotion } from "../services/store.js";

const stack = [];
const motionMs = (normal) => reducedMotion() ? 0 : normal;

/** Register a closable layer. Returns `request()`; call it to close the layer (goes through history). */
export function pushLayer(close) {
  stack.push(close);
  try { history.pushState({ dfx: stack.length }, ""); } catch { /* not fatal */ }
  return () => {
    const i = stack.lastIndexOf(close);
    if (i < 0) return;
    if (i === stack.length - 1) history.back();   // popstate handler below runs `close`
    else { stack.splice(i, 1); close(); }
  };
}

window.addEventListener("popstate", () => {
  const close = stack.pop();
  if (close) close();
});

export const hasLayers = () => stack.length > 0;

// ---------------------------------------------------------------------------------------------
function layerRoot() {
  let r = document.getElementById("overlay-root");
  if (!r) { r = h("div", { id: "overlay-root" }); document.body.appendChild(r); }
  return r;
}

/** Draggable bottom sheet. Drag down (or fling) to dismiss. */
export function openSheet({ title, body, onClose, tall = false, footer = null } = {}) {
  const root = layerRoot();
  const scrim = h("div", { class: "scrim" });
  const content = h("div", { class: "sheet-body" }, body);
  let request = () => {};
  const heading = title ? h("div", { class: "sheet-heading" },
    h("div", { class: "sheet-title" }, title),
    h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": `关闭${title}`, title: "关闭", onclick: () => request() }, icon("close", 20))) : null;
  const sheet = h("div", { class: "sheet" + (tall ? " tall" : ""), role: "dialog", "aria-modal": "true", "aria-label": title || "面板" },
    h("div", { class: "sheet-handle" }, h("span")),
    heading, content, footer ? h("div", { class: "sheet-footer" }, footer) : null);
  root.append(scrim, sheet);
  requestAnimationFrame(() => { scrim.classList.add("in"); sheet.classList.add("in"); });

  let closed = false;
  const closeImpl = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove("in");
    sheet.classList.remove("in");
    sheet.style.transform = "";
    setTimeout(() => { scrim.remove(); sheet.remove(); }, motionMs(320));
    onClose && onClose();
  };
  request = pushLayer(closeImpl);
  scrim.addEventListener("click", request);

  // drag to dismiss (handle + title area)
  let startY = 0, lastY = 0, lastT = 0, vel = 0, dragging = false;
  const grip = sheet.querySelector(".sheet-handle");
  const down = (e) => { dragging = true; startY = lastY = e.clientY; lastT = performance.now(); vel = 0; sheet.classList.add("dragging"); grip.setPointerCapture && grip.setPointerCapture(e.pointerId); };
  const move = (e) => {
    if (!dragging) return;
    const dy = Math.max(0, e.clientY - startY), now = performance.now();
    vel = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY; lastT = now;
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("dragging");
    const dy = e.clientY - startY;
    if (dy > sheet.offsetHeight * 0.3 || vel > 0.6) request();
    else sheet.style.transform = "";
  };
  grip.addEventListener("pointerdown", down);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
  return { close: request, el: sheet, content };
}

/** Centered modal for dangerous or blocking decisions. */
export function openDialog({ title, body, actions = [], onClose } = {}) {
  const root = layerRoot();
  const scrim = h("div", { class: "scrim" });
  const buttons = actions.map((a) => h("button", {
    class: "btn " + (a.primary ? "filled" : "text") + (a.danger ? " danger" : ""), type: "button",
    onclick: async () => {
      const result = a.onClick ? await a.onClick() : undefined;
      if (result !== false) request();
    },
  }, a.label));
  const dlg = h("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-label": title },
    h("h2", null, title), h("div", { class: "dialog-body" }, body), h("div", { class: "dialog-actions" }, buttons));
  root.append(scrim, dlg);
  requestAnimationFrame(() => { scrim.classList.add("in"); dlg.classList.add("in"); });
  let closed = false;
  const closeImpl = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove("in"); dlg.classList.remove("in");
    setTimeout(() => { scrim.remove(); dlg.remove(); }, motionMs(240));
    onClose && onClose();
  };
  const request = pushLayer(closeImpl);
  return { close: request, el: dlg };
}

export function confirmDialog({ title, message, confirmLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openDialog({
      title, body: message,
      actions: [{ label: "取消" }, { label: confirmLabel, primary: true, danger, onClick: () => { answered = true; resolve(true); } }],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export function promptDialog({ title, label = "", value = "", confirmLabel = "确定" }) {
  return new Promise((resolve) => {
    const input = h("input", { class: "text-field", type: "text", value, "aria-label": label || title, autocapitalize: "off", spellcheck: "false" });
    let answered = false;
    const d = openDialog({
      title, body: h("label", { class: "field" }, label ? h("span", null, label) : null, input),
      actions: [{ label: "取消" }, { label: confirmLabel, primary: true, onClick: () => { answered = true; resolve(input.value.trim() || null); } }],
      onClose: () => { if (!answered) resolve(null); },
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { answered = true; resolve(input.value.trim() || null); d.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

/** Action menu presented as a bottom sheet (touch-friendly long-press menu). */
export function openMenu(title, items) {
  const list = h("div", { class: "menu" });
  let sheet;
  for (const it of items) {
    if (!it) continue;
    list.appendChild(h("button", {
      class: "menu-item" + (it.danger ? " danger" : ""), type: "button",
      onclick: () => { sheet.close(); setTimeout(() => it.onClick && it.onClick(), motionMs(160)); },
    }, it.icon ? icon(it.icon, 20) : null, h("span", null, it.label)));
  }
  sheet = openSheet({ title, body: list });
  return sheet;
}

export { clear };
