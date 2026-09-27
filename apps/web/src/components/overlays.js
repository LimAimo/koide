// Overlays. Every overlay registers a layer so Android Back closes them in the right order:
// context menu -> dialog -> bottom sheet -> drawer -> AI fullscreen -> settings page -> (finally) leave the app.

import { h, icon, clear, toast } from "./dom.js";
import { reducedMotion } from "../services/store.js";
import { velocityTracker } from "../services/motion.js";

const stack = [];
let pendingBack = false;
const motionMs = (normal) => reducedMotion() ? 0 : normal;

function syncHistory() {
  if (pendingBack) return;
  const last = stack.filter((entry) => entry.registered).at(-1);
  if (last?.closed) { pendingBack = true; history.back(); return; }
  for (const entry of [...stack]) {
    if (entry.closed) { if (!entry.registered) stack.splice(stack.indexOf(entry), 1); continue; }
    if (!entry.registered) {
      try { history.pushState({ dfx: true }, ""); entry.registered = true; }
      catch { /* A blocked History API must not block closing a surface. */ }
    }
  }
}

/** Register a closable layer. Returns `request()`; call it to close the layer (goes through history). */
export function pushLayer(close) {
  const entry = { close, closed: false, registered: false };
  const request = () => {
    if (entry.closed) return;
    entry.closed = true;
    close();
    syncHistory();
  };
  entry.request = request;
  stack.push(entry); syncHistory();
  return request;
}

window.addEventListener("popstate", () => {
  const entry = stack.filter((item) => item.registered).at(-1);
  if (entry) {
    stack.splice(stack.indexOf(entry), 1);
    if (!entry.closed) { entry.closed = true; entry.close(); }
  }
  pendingBack = false;
  syncHistory();
});

export const hasLayers = () => stack.some((entry) => !entry.closed);
export const closeTopLayer = () => { if (!pendingBack) stack.filter((entry) => !entry.closed).at(-1)?.request(); };

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
  const enter = requestAnimationFrame(() => { if (!closed) { scrim.classList.add("in"); sheet.classList.add("in"); } });

  let closed = false;
  const closeImpl = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(enter);
    sheet.classList.remove("dragging");
    sheet.inert = true; scrim.style.pointerEvents = "none";
    scrim.classList.remove("in");
    sheet.classList.remove("in");
    sheet.style.transform = "";
    setTimeout(() => { scrim.remove(); sheet.remove(); }, motionMs(320));
    onClose && onClose();
  };
  request = pushLayer(closeImpl);
  scrim.addEventListener("click", request);

  // drag to dismiss (handle + title area)
  let drag = null;
  const grip = sheet.querySelector(".sheet-handle");
  const down = (e) => {
    if (closed || drag || e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    // Capture the current transform if the opening or return transition is interrupted.
    const matrix = getComputedStyle(sheet).transform || "";
    const values = matrix.match(/matrix(?:3d)?\(([^)]+)\)/)?.[1].split(",").map(Number);
    const base = values ? (values.length === 16 ? values[13] : values[5]) : 0;
    drag = { id: e.pointerId, y: e.clientY, base, distance: base, velocity: velocityTracker(e.clientY) };
    sheet.classList.add("dragging"); sheet.style.transform = `translateY(${base}px)`;
    grip.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id || closed) return;
    drag.velocity.add(e.clientY);
    drag.distance = Math.max(0, drag.base + e.clientY - drag.y);
    sheet.style.transform = `translateY(${drag.distance}px)`;
  };
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    grip.releasePointerCapture?.(d.id);
    sheet.classList.remove("dragging");
    if (e.type === "pointerup" && (d.distance > sheet.offsetHeight * 0.3 || d.velocity.value() > 0.6)) request();
    else sheet.style.transform = "";
  };
  grip.addEventListener("pointerdown", down);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
  grip.addEventListener("lostpointercapture", up);
  return { close: request, el: sheet, content };
}

/** Centered modal for dangerous or blocking decisions. */
export function openDialog({ title, body, actions = [], onClose } = {}) {
  const root = layerRoot();
  const scrim = h("div", { class: "scrim" });
  const buttons = actions.map((a) => h("button", {
    class: "btn " + (a.primary ? "filled" : "text") + (a.danger ? " danger" : ""), type: "button",
    onclick: async () => {
      if (closed || busy) return;
      busy = true; buttons.forEach((button) => { button.disabled = true; });
      try {
        const result = a.onClick ? await a.onClick() : undefined;
        if (result !== false) request();
      } catch (error) { toast(error.message || "操作失败，请重试"); }
      finally { busy = false; buttons.forEach((button) => { button.disabled = false; }); }
    },
  }, a.label));
  const dlg = h("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-label": title },
    h("h2", null, title), h("div", { class: "dialog-body" }, body), h("div", { class: "dialog-actions" }, buttons));
  root.append(scrim, dlg);
  const enter = requestAnimationFrame(() => { if (!closed) { scrim.classList.add("in"); dlg.classList.add("in"); } });
  let closed = false, busy = false;
  const closeImpl = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(enter);
    dlg.inert = true; scrim.style.pointerEvents = "none";
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
  let selected = false;
  for (const it of items) {
    if (!it) continue;
    list.appendChild(h("button", {
      class: "menu-item" + (it.danger ? " danger" : ""), type: "button",
      onclick: () => { if (selected) return; selected = true; sheet.close(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 20) : null, h("span", null, it.label)));
  }
  sheet = openSheet({ title, body: list });
  return sheet;
}

export { clear };
