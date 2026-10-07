// 三种设备共享内容；桌面使用常驻分栏，平板使用来自两侧的面板，手机保留自由高度聊天面板。
import { pushLayer } from "./overlays.js";
import { viewportMode } from "../services/viewport.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const vh = () => window.visualViewport?.height || window.innerHeight;
const MIN_EDITOR = 360, MIN_TABLET_CENTER = 480;

export function setupLayout({ app, files, ai, grip, scrim, resizers = {}, terminal, onCloseAI }) {
  const center = app.querySelector(".center-stack");
  const disposers = [], cancelDrags = [];
  function listen(target, type, handler, options) {
    target?.addEventListener(type, handler, options);
    disposers.push(() => target?.removeEventListener?.(type, handler, options));
  }
  const store = {
    get(key, fallback, min, max) { try { return clamp(finite(localStorage.getItem(key) ?? fallback, fallback), min, max); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, String(Math.round(value))); } catch { /* 无存储时仍可调整 */ } },
  };
  const preferred = {
    files: store.get("dfx.filesW", 264, 180, 460), ai: store.get("dfx.aiW", 380, 280, 640),
    terminal: store.get("dfx.terminalH", 260, 140, 900),
  };
  const sizes = { files: preferred.files, ai: preferred.ai, terminal: preferred.terminal };
  let mode = "", device = "", panels = { filesVisible: true, aiVisible: false, terminalVisible: false };
  let drawerClose = null, aiClose = null, fullClose = null, lastPanel = "ai";
  let drawerAnchor = null, aiAnchor = null, dr = null, sd = null, sheetH = null, isFull = false;
  let refreshing = false, destroyed = false, pendingRefresh = null, lastGeometry = "";

  const dismiss = (request) => { if (!request) return; request.dismiss ? request.dismiss() : request(); };
  const closeLayer = (request, quiet = false) => { if (quiet) dismiss(request); else request?.(); };
  const cssNumber = (name) => Math.max(0, finite(parseFloat(getComputedStyle(app).getPropertyValue(name)), 0));
  const externalWidth = () => cssNumber("--surface-left") + cssNumber("--surface-right");
  const hasWorkspace = () => !app.classList.contains("no-ws");
  const desktopFiles = () => panels.filesVisible && hasWorkspace() && !app.classList.contains("studio-focus");
  const visibleAI = () => panels.aiVisible && hasWorkspace();
  function setClass(name, on) { if (app.classList.contains(name) !== !!on) app.classList.toggle(name, !!on); }
  function accessible(element, visible, modal = false) {
    if (!element) return;
    element.inert = !visible;
    element.setAttribute("aria-hidden", String(!visible));
    element.setAttribute("role", modal ? "dialog" : "complementary");
    modal ? element.setAttribute("aria-modal", "true") : element.removeAttribute("aria-modal");
  }
  function notifySize() {
    const geometry = JSON.stringify([mode, window.innerWidth, vh(), hasWorkspace(), desktopFiles(), visibleAI(), panels.terminalVisible,
      app.classList.contains("files-open"), app.classList.contains("tablet-panel-overlay"), app.style.getPropertyValue("--layout-left"), app.style.getPropertyValue("--layout-right"),
      cssNumber("--surface-left"), cssNumber("--surface-right"), sizes.files, sizes.ai, sizes.terminal, Math.round(center?.getBoundingClientRect?.().width || 0)]);
    if (lastGeometry === geometry) return;
    lastGeometry = geometry; window.dispatchEvent?.(new Event("koide:layout-resize"));
  }

  function closeAI(notify = true, quiet = false) {
    panels = { ...panels, aiVisible: false };
    setClass("ai-hidden", true);
    const request = aiClose; aiClose = null;
    closeLayer(request, quiet);
    if (ai.contains(document.activeElement) && aiAnchor?.isConnected !== false) aiAnchor?.focus?.();
    aiAnchor = null;
    if (notify) onCloseAI?.();
  }
  function removeDrawer() {
    setClass("files-open", false);
    drawerClose = null;
    if (drawerAnchor?.isConnected !== false && drawerAnchor?.focus) drawerAnchor.focus();
    drawerAnchor = null;
    refreshLayout();
  }
  function closeDrawer(quiet = false) {
    const request = drawerClose; drawerClose = null;
    if (request) closeLayer(request, quiet);
    else if (app.classList.contains("files-open")) removeDrawer();
  }
  function openDrawer(anchor) {
    if (device === "desktop" || !hasWorkspace()) return;
    if (app.classList.contains("files-open")) { closeDrawer(); return; }
    drawerAnchor = anchor?.currentTarget || anchor || document.activeElement;
    lastPanel = "files";
    const bothFit = window.innerWidth - externalWidth() - tabletWidth("files") - tabletWidth("ai") >= MIN_TABLET_CENTER;
    if (device === "tablet" && visibleAI() && !bothFit) closeAI(true, true);
    setClass("files-open", true);
    drawerClose = pushLayer(removeDrawer);
    refreshLayout();
    requestAnimationFrame(() => { if (!destroyed && app.classList.contains("files-open")) (files.querySelector("button") || files).focus?.(); });
  }
  function closeActivePanel() {
    if (device === "tablet" && lastPanel === "ai" && visibleAI()) closeAI();
    else closeDrawer();
    refreshLayout();
  }
  listen(scrim, "click", closeActivePanel);
  listen(document, "keydown", (event) => {
    if (event.key !== "Tab") return;
    const active = drawerClose?.isTop?.() && files.getAttribute("aria-modal") === "true" ? files
      : ((aiClose?.isTop?.() || fullClose?.isTop?.()) && ai.getAttribute("aria-modal") === "true") ? ai : null;
    if (!active) return;
    const list = [...active.querySelectorAll("button, input, textarea, select, a[href], [tabindex]")].filter((el) => !el.disabled && !el.hidden && el.getAttribute("tabindex") !== "-1" && !el.inert && !el.closest?.("[hidden], [inert]"));
    const current = document.activeElement, first = list[0], last = list.at(-1);
    if (!list.length) { event.preventDefault(); active.setAttribute("tabindex", "-1"); active.focus?.(); }
    else if (event.shiftKey && (current === first || !active.contains(current))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (current === last || !active.contains(current))) { event.preventDefault(); first.focus(); }
  });

  function tabletWidth(which) { return Math.round(Math.min(which === "files" ? 320 : 420, window.innerWidth * (which === "files" ? .8 : .88))); }
  function terminalBounds() {
    const measured = center?.getBoundingClientRect?.().height;
    const height = measured > 100 ? measured : Math.max(0, vh() - (app.querySelector(".appbar")?.offsetHeight || 56));
    return { min: 140, max: Math.max(140, Math.floor(height - 220)) };
  }
  function widthBounds(which) {
    const other = which === "files" ? (visibleAI() ? sizes.ai + 1 : 0) : (desktopFiles() ? sizes.files + 1 : 0);
    const min = which === "files" ? 180 : 280, max = which === "files" ? 460 : 640;
    return { min, max: Math.max(min, Math.min(max, window.innerWidth - MIN_EDITOR - other - 1)) };
  }
  function ariaSize(element, bounds, now, orientation) {
    if (!element) return;
    element.setAttribute("aria-orientation", orientation);
    element.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
    element.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
    element.setAttribute("aria-valuenow", String(Math.round(now)));
  }

  function refreshLayout() {
    if (refreshing || destroyed) return;
    refreshing = true;
    try {
      const filesOpen = hasWorkspace() && app.classList.contains("files-open");
      let aiVisible = visibleAI();
      const bounds = terminalBounds();
      sizes.terminal = clamp(preferred.terminal, bounds.min, bounds.max);
      app.style.setProperty("--terminal-h", `${sizes.terminal}px`);
      ariaSize(resizers.r3, bounds, sizes.terminal, "horizontal");
      if (device === "desktop") {
        const showFiles = desktopFiles(), budget = Math.max(0, window.innerWidth - MIN_EDITOR - Number(showFiles) - Number(aiVisible));
        sizes.files = preferred.files; sizes.ai = preferred.ai;
        let excess = Math.max(0, (showFiles ? sizes.files : 0) + (aiVisible ? sizes.ai : 0) - budget);
        if (showFiles) { const cut = Math.min(excess, sizes.files - 180); sizes.files -= cut; excess -= cut; }
        if (aiVisible) sizes.ai -= Math.min(excess, sizes.ai - 280);
        app.style.setProperty("--files-w", `${sizes.files}px`);
        app.style.setProperty("--ai-w", `${sizes.ai}px`);
        ariaSize(resizers.r1, widthBounds("files"), sizes.files, "vertical");
        ariaSize(resizers.r2, widthBounds("ai"), sizes.ai, "vertical");
        accessible(files, showFiles); accessible(ai, aiVisible);
        center && (center.inert = false);
      } else if (device === "tablet") {
        const fw = tabletWidth("files"), aw = tabletWidth("ai"), available = window.innerWidth - externalWidth();
        if (filesOpen && aiVisible && available - fw - aw < MIN_TABLET_CENTER) {
          if (lastPanel === "files") { closeAI(true, true); aiVisible = false; }
          else closeDrawer(true);
        }
        const nowFiles = hasWorkspace() && app.classList.contains("files-open");
        const total = (nowFiles ? fw : 0) + (aiVisible ? aw : 0);
        const push = available - total >= MIN_TABLET_CENTER;
        const filePush = nowFiles && push, aiPush = aiVisible && push;
        setClass("tablet-files-push", filePush); setClass("tablet-ai-push", aiPush);
        setClass("tablet-panel-overlay", (nowFiles || aiVisible) && !push);
        app.style.setProperty("--tablet-files-w", `${fw}px`); app.style.setProperty("--tablet-ai-w", `${aw}px`);
        app.style.setProperty("--layout-left", filePush ? `${fw}px` : "0px");
        app.style.setProperty("--layout-right", aiPush ? `${aw}px` : "0px");
        accessible(files, nowFiles, nowFiles && !push); accessible(ai, aiVisible, aiVisible && !push);
        center && (center.inert = (nowFiles || aiVisible) && !push);
      } else {
        accessible(files, filesOpen, filesOpen); accessible(ai, aiVisible, mode === "port" && isFull);
        center && (center.inert = filesOpen || (mode === "port" && isFull && aiVisible));
        if (mode === "land") {
          sizes.ai = clamp(preferred.ai, 200, Math.max(200, window.innerWidth - 240));
          app.style.setProperty("--ai-w", `${sizes.ai}px`);
          ariaSize(resizers.r2, { min: 200, max: Math.max(200, window.innerWidth - 240) }, sizes.ai, "vertical");
        }
      }
      if (device !== "tablet") {
        setClass("tablet-files-push", false); setClass("tablet-ai-push", false); setClass("tablet-panel-overlay", false);
        app.style.setProperty("--layout-left", "0px"); app.style.setProperty("--layout-right", "0px");
      }
      for (const [name, element] of Object.entries(resizers)) {
        if (!element) continue;
        const shown = name === "r3" ? device === "desktop" && panels.terminalVisible && hasWorkspace()
          : name === "r1" ? device === "desktop" && desktopFiles() : (device === "desktop" || mode === "land") && visibleAI();
        element.inert = !shown; element.setAttribute("aria-hidden", String(!shown));
        element.setAttribute("tabindex", shown ? "0" : "-1");
      }
      grip?.setAttribute("tabindex", mode === "port" && visibleAI() ? "0" : "-1");
      notifySize();
    } finally { refreshing = false; }
  }

  function syncPanels(next = {}) {
    const wasAI = panels.aiVisible;
    panels = { ...panels, ...next };
    setClass("files-hidden", !panels.filesVisible); setClass("ai-hidden", !panels.aiVisible);
    if (device === "tablet") {
      if (visibleAI() && !wasAI) {
        aiAnchor = document.activeElement;
        lastPanel = "ai";
        if (app.classList.contains("files-open") && window.innerWidth - externalWidth() - tabletWidth("files") - tabletWidth("ai") < MIN_TABLET_CENTER) closeDrawer(true);
      }
      if (visibleAI() && !aiClose) {
        const request = pushLayer(() => { if (aiClose !== request) return; aiClose = null; closeAI(); refreshLayout(); });
        aiClose = request;
        if (!wasAI) requestAnimationFrame(() => { if (!destroyed && visibleAI() && device === "tablet") (ai.querySelector("button") || ai).focus?.(); });
      }
    }
    if ((!visibleAI() || device !== "tablet") && aiClose) { const request = aiClose; aiClose = null; closeLayer(request, device !== "tablet"); }
    if (!visibleAI() && isFull) setFull(false);
    if (!hasWorkspace()) closeDrawer(true);
    refreshLayout();
  }

  const maxSheetH = () => Math.max(1, vh());
  const halfSheetH = () => Math.round(maxSheetH() * .5);
  const minOpenH = () => Math.round(maxSheetH() * .24);
  function setH(px) {
    sheetH = clamp(Math.round(px), 1, maxSheetH());
    app.style.setProperty("--sheet-h", `${sheetH}px`);
    ariaSize(grip, { min: minOpenH(), max: maxSheetH() }, sheetH, "horizontal");
  }
  function setFull(on, quiet = false) {
    isFull = !!on;
    ai.classList.toggle("full", isFull);
    if (isFull) {
      setH(maxSheetH());
      if (!fullClose) fullClose = pushLayer(() => { fullClose = null; isFull = false; ai.classList.remove("full"); if (mode === "port") setH(halfSheetH()); refreshLayout(); });
    } else if (fullClose) { const request = fullClose; fullClose = null; closeLayer(request, quiet); }
    refreshLayout();
  }
  function openSheetHalf() {
    if (device === "tablet") return syncPanels({ aiVisible: true });
    if (mode !== "port") return;
    setFull(false); setH(halfSheetH());
  }
  function expandSheet(minRatio = .5) {
    if (device === "tablet") return syncPanels({ aiVisible: true });
    if (mode !== "port") return;
    const target = Math.round(maxSheetH() * clamp(minRatio, .25, 1));
    if (isFull || (sheetH ?? 0) >= target) return;
    setFull(false); setH(target);
  }
  function closeSheet() {
    setFull(false);
    closeAI(); refreshLayout();
  }
  function clampSheetToViewport() {
    if (mode === "port" && sheetH !== null) setH(isFull ? maxSheetH() : Math.min(sheetH, maxSheetH()));
  }

  // 手机文件边缘滑动：垂直滚动优先，取消手势只恢复原来的开关状态。
  function clearDrawerDrag() {
    dr = null; setClass("files-dragging", false);
    files.style.transform = ""; scrim.style.opacity = ""; scrim.style.pointerEvents = "";
  }
  cancelDrags.push(clearDrawerDrag);
  listen(window, "pointerdown", (e) => {
    if (device !== "phone" || e.pointerType === "mouse" || e.isPrimary === false) return;
    const open = app.classList.contains("files-open");
    if ((!open && e.clientX <= 22) || (open && files.contains(e.target))) dr = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastT: performance.now(), v: 0, open, w: files.offsetWidth || 300, active: false };
  }, { passive: true });
  listen(window, "pointermove", (e) => {
    if (!dr || e.pointerId !== dr.id) return;
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    if (!dr.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) { dr.active = true; setClass("files-dragging", true); }
      else if (Math.abs(dy) > 12) return clearDrawerDrag(); else return;
    }
    const now = performance.now(); dr.v = (e.clientX - dr.lastX) / Math.max(1, now - dr.lastT); dr.lastX = e.clientX; dr.lastT = now;
    const x = clamp((dr.open ? 0 : -dr.w) + dx, -dr.w, 0);
    files.style.transform = `translateX(${x}px)`; scrim.style.opacity = String(1 + x / dr.w); scrim.style.pointerEvents = "auto";
  }, { passive: true });
  listen(window, "pointerup", (e) => {
    if (!dr || e.pointerId !== dr.id) return;
    const d = dr, x = parseFloat((files.style.transform.match(/-?[\d.]+/) || ["0"])[0]); clearDrawerDrag();
    if (!d.active) return;
    const open = d.v > .35 ? true : d.v < -.35 ? false : x > -d.w / 2;
    if (open && !d.open) openDrawer(); else if (!open && d.open) closeDrawer();
  });
  listen(window, "pointercancel", clearDrawerDrag);

  function cancelSheetDrag() {
    if (!sd) return;
    const before = sd; sd = null; ai.classList.remove("dragging");
    setH(before.h); setFull(before.full);
  }
  cancelDrags.push(cancelSheetDrag);
  listen(grip, "pointerdown", (e) => {
    if (mode !== "port" || e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    grip.setPointerCapture?.(e.pointerId);
    sd = { id: e.pointerId, y: e.clientY, h: sheetH || ai.offsetHeight || halfSheetH(), full: isFull, lastY: e.clientY, lastT: performance.now(), v: 0, moved: false };
    ai.classList.add("dragging");
  });
  listen(grip, "pointermove", (e) => {
    if (!sd || e.pointerId !== sd.id) return;
    const now = performance.now(); sd.v = (sd.lastY - e.clientY) / Math.max(1, now - sd.lastT); sd.lastY = e.clientY; sd.lastT = now;
    if (Math.abs(e.clientY - sd.y) > 4) sd.moved = true;
    setH(sd.h + sd.y - e.clientY);
  });
  listen(grip, "pointerup", (e) => {
    if (!sd || e.pointerId !== sd.id) return;
    const s = sd; sd = null; ai.classList.remove("dragging");
    if (!s.moved) return;
    const max = maxSheetH(), current = sheetH || halfSheetH(), projected = current + s.v * 180;
    if (projected < minOpenH() || s.v < -.75) return closeSheet();
    if (s.v > .52 || projected >= max * .86 || current >= max - 24) return setFull(true);
    setFull(false); setH(clamp(current, minOpenH(), max - 1));
  });
  listen(grip, "pointercancel", cancelSheetDrag); listen(grip, "lostpointercapture", cancelSheetDrag);
  listen(grip, "keydown", (e) => {
    if (mode !== "port" || !["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "End") return setFull(true);
    const current = sheetH || halfSheetH();
    setFull(false);
    setH(e.key === "Home" ? minOpenH() : clamp(current + (e.key === "ArrowUp" ? 32 : -32), minOpenH(), maxSheetH()));
  });

  // 首选尺寸只由用户改变；窗口收窄时的临时压缩不会覆盖下一次宽屏的首选宽度。
  function makeResizer(element, which, key, vertical = false) {
    if (!element) return;
    let drag = null;
    const allowed = () => device === "desktop" && (which === "files" ? desktopFiles() : which === "ai" ? visibleAI() : panels.terminalVisible && hasWorkspace());
    const bounds = () => which === "terminal" ? terminalBounds() : widthBounds(which);
    const set = (value) => { const b = bounds(); preferred[which] = clamp(value, b.min, b.max); refreshLayout(); };
    function cancel() {
      if (!drag) return;
      preferred[which] = drag.preferred; drag = null; element.classList.remove("dragging"); refreshLayout();
    }
    cancelDrags.push(cancel);
    listen(element, "pointerdown", (e) => {
      if (!allowed() || e.isPrimary === false || (e.button != null && e.button !== 0)) return;
      e.preventDefault(); element.setPointerCapture?.(e.pointerId);
      drag = { id: e.pointerId, position: vertical ? e.clientY : e.clientX, size: sizes[which], preferred: preferred[which] };
      element.classList.add("dragging");
    });
    listen(element, "pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const delta = (vertical ? e.clientY : e.clientX) - drag.position;
      set(drag.size + (which === "files" ? delta : -delta));
    });
    listen(element, "pointerup", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null; element.classList.remove("dragging"); store.set(key, preferred[which]);
    });
    listen(element, "pointercancel", cancel); listen(element, "lostpointercapture", cancel);
    listen(element, "keydown", (e) => {
      const arrows = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
      if (!allowed() || ![...arrows, "Home", "End"].includes(e.key)) return;
      e.preventDefault(); const b = bounds();
      const delta = (e.key === arrows[1] ? 1 : -1) * (which === "files" ? 1 : -1) * (e.shiftKey ? 64 : 16);
      set(e.key === "Home" ? b.min : e.key === "End" ? b.max : sizes[which] + delta);
      store.set(key, preferred[which]);
    });
    listen(element, "dblclick", () => { if (allowed()) { preferred[which] = which === "files" ? 264 : which === "ai" ? 380 : 260; refreshLayout(); store.set(key, preferred[which]); } });
  }
  makeResizer(resizers.r1, "files", "dfx.filesW"); makeResizer(resizers.r2, "ai", "dfx.aiW"); makeResizer(resizers.r3, "terminal", "dfx.terminalH", true);

  function updateMode() {
    const nextDevice = viewportMode({ width: window.innerWidth, height: window.innerHeight });
    const next = nextDevice === "desktop" ? "wide" : nextDevice === "tablet" ? "tablet" : window.innerWidth > window.innerHeight ? "land" : "port";
    if (next !== mode) {
      cancelDrags.forEach((cancel) => cancel());
      closeDrawer(true); setFull(false, true);
      if (aiClose) { const request = aiClose; aiClose = null; dismiss(request); }
      app.classList.remove("mode-wide", "mode-tablet", "mode-land", "mode-port"); app.classList.add(`mode-${next}`);
      mode = next; device = nextDevice; app.dataset.layout = device;
      if (next !== "port") { sheetH = null; app.style.removeProperty("--sheet-h"); }
      else clampSheetToViewport();
      syncPanels();
    } else { clampSheetToViewport(); refreshLayout(); }
  }
  listen(window, "resize", updateMode); listen(window, "orientationchange", updateMode);
  listen(window, "koide:surface-layout", () => {
    if (!refreshing) return refreshLayout();
    if (pendingRefresh === null) pendingRefresh = requestAnimationFrame(() => { pendingRefresh = null; refreshLayout(); });
  });
  listen(window.visualViewport, "resize", () => { clampSheetToViewport(); refreshLayout(); });
  const observer = typeof ResizeObserver === "function" && center ? new ResizeObserver(refreshLayout) : null;
  observer?.observe(center);
  updateMode();
  return {
    openDrawer, closeDrawer, openSheetHalf, closeSheet, expandSheet, syncPanels,
    get mode() { return mode; }, get device() { return device; },
    destroy() { cancelDrags.forEach((cancel) => cancel()); closeDrawer(true); setFull(false, true); const request = aiClose; aiClose = null; dismiss(request); destroyed = true; if (pendingRefresh !== null) cancelAnimationFrame(pendingRefresh); observer?.disconnect(); disposers.forEach((dispose) => dispose()); },
  };
}
