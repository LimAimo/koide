// 可关闭层共享返回键语义；输入节点在设备模式切换时保留。
import { h, icon, clear } from "./dom.js";
import { viewportMode, surfaceSide } from "../services/viewport.js";

const stack = [];
let sequence = 0, pendingBack = 0, hosts = {}, lastAnchor = null;
const surfaces = new Set(), inertLocks = new Map(), menuOrigins = new WeakMap();

export function configureSurfaces({ app, pageHost } = {}) {
  hosts = { app, pageHost };
  for (const surface of surfaces) surface.layout();
}

/** 用户明确打开文件时退出完整功能页；确认框和普通工具面板保持原样。 */
export function dismissPageSurfaces() {
  for (const surface of [...surfaces]) if (surface.presentation === "page") surface.close.dismiss();
}

document.addEventListener("click", (event) => {
  const trigger = event.target?.closest?.("button, [role='button'], a");
  if (trigger) lastAnchor = trigger;
}, true);
document.addEventListener("contextmenu", (event) => {
  const element = event.target;
  lastAnchor = { element, getBoundingClientRect: () => ({ left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY, width: 1, height: 1 }) };
}, true);
function writeLayerHistory(record) {
  try { history.pushState({ ...history.state, dfx: stack.indexOf(record) + 1, koideLayer: record.id }, ""); record.history = true; } catch { /* 无历史权限仍可关闭 */ }
}

/** close() 幂等且立即收起；dismiss() 用于布局切换，不回退浏览器历史。 */
export function pushLayer(close) {
  const record = { id: ++sequence, close, closed: false, history: false };
  stack.push(record);
  // back 是异步导航；它完成前 pushState 会改变导航目标，甚至离开当前文档。
  if (!pendingBack) writeLayerHistory(record);
  const dismiss = () => {
    if (record.closed) return;
    record.closed = true;
    const index = stack.indexOf(record);
    if (index >= 0) stack.splice(index, 1);
    close();
  };
  const request = () => {
    if (record.closed) return;
    const top = stack.at(-1) === record;
    dismiss();
    if (top && record.history) {
      pendingBack++;
      try { history.back(); } catch { pendingBack--; }
    }
  };
  request.dismiss = dismiss;
  request.isTop = () => stack.at(-1) === record;
  return request;
}

window.addEventListener("popstate", (event) => {
  if (pendingBack) {
    pendingBack--;
    if (!pendingBack) for (const record of stack) if (!record.history) writeLayerHistory(record);
    return;
  }
  const target = event.state?.koideLayer;
  if (Number.isSafeInteger(target) || event.state === null) {
    for (const record of [...stack].reverse()) {
      if (record.id <= (target || 0)) break;
      record.closed = true;
      stack.splice(stack.indexOf(record), 1);
      record.close();
    }
  } else {
    const record = stack.pop();
    if (record) { record.closed = true; record.close(); }
  }
});
export const hasLayers = () => stack.length > 0;

function layerRoot() {
  let root = document.getElementById("overlay-root");
  if (!root) { root = h("div", { id: "overlay-root" }); document.body.appendChild(root); }
  return root;
}
function activeAnchor(anchor) {
  let target = anchor?.currentTarget || anchor || lastAnchor || (document.activeElement?.tagName !== "BODY" ? document.activeElement : null);
  const seen = new Set();
  while (target && !seen.has(target) && menuOrigins.has(target)) { seen.add(target); target = menuOrigins.get(target); }
  return target;
}
function reducedMotion() { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; }
function connected(element) { return !!element && (element.isConnected ?? document.body.contains(element)); }
function focusables(element) {
  return [...element.querySelectorAll("button, input, textarea, select, a[href], [tabindex]")].filter((node) => !node.disabled && !node.hidden && node.getAttribute("tabindex") !== "-1" && !node.closest?.("[hidden], [inert]"));
}
function setInert(nodes) {
  for (const node of nodes) {
    const lock = inertLocks.get(node) || { count: 0, value: !!node.inert };
    lock.count++; inertLocks.set(node, lock); node.inert = true;
  }
  return () => {
    for (const node of nodes) {
      const lock = inertLocks.get(node);
      if (!lock || --lock.count > 0) continue;
      node.inert = lock.value; inertLocks.delete(node);
    }
  };
}
function accessibility(element, request, trigger, { modal = false, menu = false } = {}) {
  let unlock = () => {}, currentModal = false;
  const setModal = (value) => {
    if (value === currentModal) return;
    unlock(); unlock = () => {}; currentModal = value;
    element.setAttribute("aria-modal", String(value));
    if (value) {
      const root = layerRoot();
      const siblings = [...root.children].filter((node) => node !== element && !node.classList.contains("scrim"));
      unlock = setInert([...document.body.children].filter((node) => node !== root).concat(siblings));
    }
  };
  const keydown = (event) => {
    if (!request.isTop()) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); request(); return; }
    const list = focusables(element);
    if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && list.length) {
      event.preventDefault();
      const index = list.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + list.length) % list.length;
      list[next].focus(); return;
    }
    if (event.key !== "Tab") return;
    if (menu) { request(); return; }
    if (!currentModal) return;
    if (!list.length) { event.preventDefault(); element.focus(); return; }
    const first = list[0], last = list.at(-1), active = document.activeElement;
    if (event.shiftKey && (active === first || !element.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !element.contains(active))) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", keydown);
  element.setAttribute("tabindex", "-1");
  setModal(modal);
  requestAnimationFrame(() => { if (request.isTop() && connected(element)) (focusables(element)[0] || element).focus(); });
  return {
    setModal,
    dispose() {
      const active = document.activeElement;
      const restore = !active || active === document.body || !connected(active) || element.contains(active);
      unlock();
      document.removeEventListener?.("keydown", keydown);
      const target = trigger?.element || trigger;
      if (restore && connected(target) && !target.closest?.("[inert]")) target.focus?.();
    },
  };
}
function layoutChanged() { if (globalThis.CustomEvent) window.dispatchEvent?.(new CustomEvent("koide:surface-layout")); }
function syncPush() {
  if (!hosts.app) return;
  for (const side of ["left", "right"]) {
    const width = [...surfaces].filter((surface) => surface.side === side).reduce((total, surface) => total + surface.pushed(), 0);
    if (width) hosts.app.style.setProperty(`--surface-${side}`, `${width}px`);
    else hosts.app.style.removeProperty(`--surface-${side}`);
  }
  const left = hosts.app.style.getPropertyValue("--surface-left"), right = hosts.app.style.getPropertyValue("--surface-right");
  if (left || right) hosts.app.dataset.surfacePush = left && right ? "both" : left ? "left" : "right";
  else delete hosts.app.dataset.surfacePush;
}

/** 手机底部面板、平板定向侧栏、桌面主区域页面或居中面板。 */
export function openSheet({ title, body, onClose, tall = false, footer = null, presentation = "panel", anchor, side, mobileFullscreen = false } = {}) {
  const trigger = activeAnchor(anchor), direction = side === "left" || side === "right" ? side : surfaceSide(trigger);
  const root = layerRoot(), scrim = h("div", { class: "scrim surface-scrim" });
  const content = h("div", { class: "sheet-body" }, body), grip = h("div", { class: "sheet-handle" }, h("span"));
  let request = () => {}, closed = false, a11y, pushed = 0, dragging = false, pointerId = null, layingOut = false;
  const heading = title ? h("div", { class: "sheet-heading" }, h("div", { class: "sheet-title" }, title), h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": `关闭${title}`, title: "关闭", onclick: () => request() }, icon("close", 20))) : null;
  const sheet = h("div", { class: "sheet adaptive-surface" + (tall ? " tall" : ""), role: "dialog", "aria-label": title || "面板", dataset: { side: direction } }, grip, heading, content, footer ? h("div", { class: "sheet-footer" }, footer) : null);
  root.append(scrim, sheet);
  const cancelDrag = () => {
    dragging = false; sheet.classList.remove("dragging"); sheet.style.transform = "";
    if (pointerId !== null) { try { grip.releasePointerCapture?.(pointerId); } catch { /* 捕获已释放 */ } }
    pointerId = null;
  };
  const clearPush = (notify = true) => {
    if (!pushed || !hosts.app) return;
    pushed = 0; syncPush(); if (notify) layoutChanged();
  };
  const layout = () => {
    if (closed || layingOut) return;
    layingOut = true;
    cancelDrag();
    const mode = viewportMode(), isPage = mode === "desktop" && presentation === "page" && hosts.pageHost;
    const width = globalThis.innerWidth || window.innerWidth;
    const sideWidth = Math.round(Math.min(560, Math.max(320, width * 0.42)));
    const center = hosts.app?.querySelector(".center-stack");
    const available = center?.getBoundingClientRect().width || hosts.app?.getBoundingClientRect().width || width;
    const canPush = mode === "tablet" && available + pushed - sideWidth >= 480;
    const previousPush = pushed;
    const placement = isPage ? "page" : mode === "desktop" ? "panel" : mode === "tablet" ? "sidepane" : mobileFullscreen ? "fullscreen" : "bottomsheet";
    sheet.dataset.mode = mode; sheet.dataset.placement = placement; sheet.dataset.push = String(canPush);
    sheet.style.setProperty("--surface-width", `${sideWidth}px`);
    const focused = sheet.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
    let moved = false;
    if (isPage) {
      for (const surface of [...surfaces]) if (surface !== managed && surface.el.dataset.placement === "page") surface.close.dismiss();
      hosts.pageHost.hidden = false;
      if (sheet.parentNode !== hosts.pageHost) { hosts.pageHost.appendChild(sheet); moved = true; }
    } else if (sheet.parentNode !== root) { root.appendChild(sheet); moved = true; }
    if (hosts.pageHost && ![...surfaces].some((surface) => surface !== managed && surface.el.dataset.placement === "page") && !isPage) hosts.pageHost.hidden = true;
    const nextPush = canPush && hosts.app ? sideWidth : 0;
    if (pushed !== nextPush) { pushed = nextPush; syncPush(); }
    scrim.hidden = !!isPage || canPush;
    a11y?.setModal(!isPage && !canPush);
    sheet.setAttribute("role", isPage || canPush ? "region" : "dialog");
    if (moved && focused && focused.isConnected !== false && !focused.closest?.("[inert]")) {
      focused.focus({ preventScroll: true });
      if (typeof selection.start === "number" && typeof selection.end === "number" && ["text", "search", "password", "url", "tel"].includes(focused.type || focused.getAttribute("type"))) focused.setSelectionRange?.(selection.start, selection.end);
    }
    if (previousPush !== pushed) layoutChanged();
    layingOut = false;
  };
  const managed = { el: sheet, layout, close: null, presentation, side: direction, pushed: () => pushed };
  const closeImpl = () => {
    if (closed) return; closed = true; cancelDrag(); clearPush(); surfaces.delete(managed);
    window.removeEventListener("resize", layout);
    window.removeEventListener("koide:layout-changed", layout);
    window.removeEventListener("koide:layout-resize", layout);
    a11y?.dispose(); sheet.classList.remove("in"); scrim.classList.remove("in");
    if (hosts.pageHost && ![...surfaces].some((surface) => surface.el.dataset.placement === "page")) hosts.pageHost.hidden = true;
    setTimeout(() => { scrim.remove(); sheet.remove(); }, reducedMotion() ? 0 : 220);
    onClose?.();
  };
  request = pushLayer(closeImpl); managed.close = request; surfaces.add(managed);
  a11y = accessibility(sheet, request, trigger);
  layout(); window.addEventListener("resize", layout); window.addEventListener("koide:layout-changed", layout); window.addEventListener("koide:layout-resize", layout);
  requestAnimationFrame(() => { if (!closed) { scrim.classList.add("in"); sheet.classList.add("in"); } });
  scrim.addEventListener("click", request);
  let startY = 0, lastY = 0, lastT = 0, velocity = 0;
  grip.addEventListener("pointerdown", (event) => {
    if (sheet.dataset.placement !== "bottomsheet") return;
    dragging = true; pointerId = event.pointerId; startY = lastY = event.clientY; lastT = performance.now(); velocity = 0;
    sheet.classList.add("dragging"); grip.setPointerCapture?.(pointerId);
  });
  grip.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const now = performance.now(); velocity = (event.clientY - lastY) / Math.max(1, now - lastT); lastY = event.clientY; lastT = now;
    sheet.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
  });
  grip.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    const dismiss = event.clientY - startY > sheet.offsetHeight * 0.3 || velocity > 0.6;
    cancelDrag(); if (dismiss) request();
  });
  grip.addEventListener("pointercancel", cancelDrag);
  return { close: request, el: sheet, content };
}

/** 简短阻塞决策始终居中，并限制键盘焦点。 */
export function openDialog({ title, body, actions = [], onClose, anchor } = {}) {
  const root = layerRoot(), trigger = activeAnchor(anchor), scrim = h("div", { class: "scrim surface-scrim" });
  let request, closed = false;
  const buttons = actions.map((action) => h("button", { class: "btn " + (action.primary ? "filled" : "text") + (action.danger ? " danger" : ""), type: "button", onclick: async () => {
    const result = action.onClick ? await action.onClick() : undefined;
    if (result !== false) request();
  } }, action.label));
  const dialog = h("div", { class: "dialog adaptive-dialog", role: "alertdialog", "aria-label": title || "确认" }, h("h2", null, title), h("div", { class: "dialog-body" }, body), h("div", { class: "dialog-actions" }, buttons));
  root.append(scrim, dialog);
  let a11y;
  request = pushLayer(() => {
    if (closed) return; closed = true; a11y?.dispose(); scrim.classList.remove("in"); dialog.classList.remove("in");
    setTimeout(() => { scrim.remove(); dialog.remove(); }, reducedMotion() ? 0 : 200); onClose?.();
  });
  a11y = accessibility(dialog, request, trigger, { modal: true });
  requestAnimationFrame(() => { if (!closed) { scrim.classList.add("in"); dialog.classList.add("in"); } });
  return { close: request, el: dialog };
}
export function confirmDialog({ title, message, confirmLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openDialog({ title, body: message, actions: [{ label: "取消" }, { label: confirmLabel, primary: true, danger, onClick: () => { answered = true; resolve(true); } }], onClose: () => { if (!answered) resolve(false); } });
  });
}
export function promptDialog({ title, label = "", value = "", confirmLabel = "确定" }) {
  return new Promise((resolve) => {
    const input = h("input", { class: "text-field", type: "text", value, "aria-label": label || title, autocapitalize: "off", spellcheck: "false" });
    let answered = false;
    const dialog = openDialog({ title, body: h("label", { class: "field" }, label ? h("span", null, label) : null, input), actions: [{ label: "取消" }, { label: confirmLabel, primary: true, onClick: () => { answered = true; resolve(input.value.trim() || null); } }], onClose: () => { if (!answered) resolve(null); } });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { answered = true; resolve(input.value.trim() || null); dialog.close(); } });
    requestAnimationFrame(() => { if (connected(input)) { input.focus(); input.select(); } });
  });
}

/** 桌面锚定菜单；触控设备遵循侧栏 / 底部面板语义。 */
export function openMenu(title, items, { anchor, side } = {}) {
  const trigger = activeAnchor(anchor), list = h("div", { class: "menu", role: "menu", "aria-label": title });
  let surface;
  for (const item of items) {
    if (!item) continue;
    const button = h("button", { class: "menu-item" + (item.danger ? " danger" : ""), type: "button", role: "menuitem", disabled: item.disabled, onclick: () => { surface.close(); item.onClick?.(); } }, item.icon ? icon(item.icon, 20) : null, h("span", null, item.label));
    if (trigger) menuOrigins.set(button, trigger);
    list.appendChild(button);
  }
  if (viewportMode() !== "desktop") return surface = openSheet({ title, body: list, anchor: trigger, side });
  const root = layerRoot(), menu = h("div", { class: "surface-popover", role: "presentation" }, list);
  root.appendChild(menu);
  let closed = false, a11y;
  const place = () => {
    const width = globalThis.innerWidth || window.innerWidth, height = globalThis.innerHeight || window.innerHeight;
    const rect = trigger?.getBoundingClientRect?.() || { left: width / 2, top: height / 3, width: 0, height: 0 };
    const bounds = menu.getBoundingClientRect(), right = rect.right ?? rect.left + rect.width, bottom = rect.bottom ?? rect.top + rect.height;
    menu.style.left = `${Math.max(8, Math.min(width - bounds.width - 8, right - bounds.width))}px`;
    menu.style.top = `${Math.max(8, Math.min(height - bounds.height - 8, bottom + 6))}px`;
    menu.style.maxHeight = `${Math.max(120, height - 16)}px`;
  };
  const outside = (event) => { if (!menu.contains(event.target) && !trigger?.contains?.(event.target)) surface.close(); };
  const close = pushLayer(() => {
    if (closed) return; closed = true; a11y?.dispose(); menu.remove();
    document.removeEventListener?.("pointerdown", outside); window.removeEventListener("resize", place);
  });
  surface = { close, el: menu, content: list };
  a11y = accessibility(menu, close, trigger, { menu: true });
  place(); window.addEventListener("resize", place); document.addEventListener("pointerdown", outside);
  return surface;
}
export { clear };
