// Layout controller. Three modes, chosen from the viewport (no page rebuild, just a class swap + CSS transitions):
//   wide  (>=900px)          files | editor | AI       resizable panels
//   land  (narrow landscape) editor | AI               files in a drawer
//   port  (portrait phone)   editor + freely draggable AI bottom sheet, files in a drawer

import { pushLayer } from "./overlays.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vh = () => (window.visualViewport ? window.visualViewport.height : window.innerHeight);

export function setupLayout({ app, files, ai, grip, scrim, resizers, onCloseAI }) {
  // ---- mode ------------------------------------------------------------------------------------------------
  let mode = "";
  function updateMode() {
    const w = window.innerWidth, hgt = window.innerHeight;
    const next = w >= 900 ? "wide" : w > hgt ? "land" : "port";
    if (next !== mode) {
      app.classList.remove("mode-wide", "mode-land", "mode-port");
      app.classList.add("mode-" + next);
      mode = next;
      if (next === "wide") closeDrawer();
      if (next === "port") clampSheetToViewport(false);
      else { app.style.removeProperty("--sheet-h"); ai.classList.remove("full"); }
    } else if (mode === "port") clampSheetToViewport(false);
  }

  // ---- drawer ------------------------------------------------------------------------------------------------
  let drawerClose = null;
  function openDrawer() {
    if (mode === "wide" || app.classList.contains("files-open")) return;
    app.classList.add("files-open");
    drawerClose = pushLayer(() => { app.classList.remove("files-open"); drawerClose = null; });
  }
  function closeDrawer() { if (drawerClose) drawerClose(); }
  scrim.addEventListener("click", closeDrawer);

  // edge-swipe to open, swipe left to close; the drawer follows the finger
  let dr = null;
  window.addEventListener("pointerdown", (e) => {
    if (mode === "wide" || e.pointerType === "mouse") return;
    const open = app.classList.contains("files-open");
    if ((!open && e.clientX <= 22) || (open && files.contains(e.target))) {
      dr = { x: e.clientX, y: e.clientY, t: performance.now(), lastX: e.clientX, lastT: performance.now(), v: 0, open, w: files.offsetWidth, active: false };
    }
  }, { passive: true });
  window.addEventListener("pointermove", (e) => {
    if (!dr) return;
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    if (!dr.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) { dr.active = true; app.classList.add("files-dragging"); }
      else if (Math.abs(dy) > 12) { dr = null; return; }
      else return;
    }
    const now = performance.now();
    dr.v = (e.clientX - dr.lastX) / Math.max(1, now - dr.lastT);
    dr.lastX = e.clientX; dr.lastT = now;
    const base = dr.open ? 0 : -dr.w;
    const x = clamp(base + dx, -dr.w, 0);
    files.style.transform = `translateX(${x}px)`;
    scrim.style.opacity = String(1 + x / dr.w);
    scrim.style.pointerEvents = "auto";
  }, { passive: true });
  function endDrawerDrag() {
    if (!dr) return;
    const d = dr; dr = null;
    if (!d.active) return;
    const x = parseFloat((files.style.transform.match(/-?[\d.]+/) || ["0"])[0]);
    app.classList.remove("files-dragging");
    files.style.transform = ""; scrim.style.opacity = ""; scrim.style.pointerEvents = "";
    const wantOpen = d.v > 0.35 ? true : d.v < -0.35 ? false : x > -d.w / 2;
    if (wantOpen) { if (!d.open) openDrawer(); } else if (d.open) closeDrawer();
  }
  window.addEventListener("pointerup", endDrawerDrag);
  window.addEventListener("pointercancel", endDrawerDrag);

  // ---- AI bottom sheet (portrait) ---------------------------------------------------------------------------------
  // Closed is represented by the global aiVisible setting. Once visible, 50% is only the opening height:
  // dragging upward/downward leaves the sheet exactly where the user releases it, except near the two natural
  // boundaries (close and full-screen). Full-screen keeps its background edge-to-edge, but CSS pads interactive
  // content below Android/iOS's top safe area.
  let sheetH = null, isFull = false, fullClose = null;
  const maxSheetH = () => Math.max(1, vh());
  const halfSheetH = () => Math.round(maxSheetH() * 0.5);
  const minOpenH = () => Math.round(maxSheetH() * 0.24);
  function setH(px) {
    sheetH = clamp(Math.round(px), 1, maxSheetH());
    app.style.setProperty("--sheet-h", `${sheetH}px`);
  }
  function syncFullLayer(viaBack = false) {
    if (isFull && !fullClose) {
      fullClose = pushLayer(() => {
        fullClose = null;
        if (isFull) {
          isFull = false;
          ai.classList.remove("full");
          setH(halfSheetH());
        }
      });
    } else if (!isFull && fullClose && !viaBack) {
      const c = fullClose; fullClose = null; c();
    }
  }
  function setFull(on, viaBack = false) {
    isFull = !!on;
    ai.classList.toggle("full", isFull);
    if (isFull) setH(maxSheetH());
    syncFullLayer(viaBack);
  }
  function openSheetHalf() {
    if (mode !== "port") return;
    setFull(false);
    setH(halfSheetH());
  }
  function expandSheet(minRatio = 0.5) {
    if (mode !== "port") return;
    const target = Math.round(maxSheetH() * clamp(minRatio, 0.25, 1));
    if (isFull || (sheetH ?? 0) >= target) return;
    setFull(false);
    setH(target);
  }
  function closeSheet() {
    if (mode !== "port") return;
    if (isFull) setFull(false);
    onCloseAI && onCloseAI();
  }
  function clampSheetToViewport(openAtHalfWhenUnset = false) {
    if (mode !== "port") return;
    if (isFull) { setH(maxSheetH()); return; }
    if (sheetH == null) {
      if (openAtHalfWhenUnset) setH(halfSheetH());
      return;
    }
    setH(Math.min(sheetH, maxSheetH()));
  }

  let sd = null;
  grip.addEventListener("pointerdown", (e) => {
    if (mode !== "port") return;
    grip.setPointerCapture && grip.setPointerCapture(e.pointerId);
    sd = { y: e.clientY, h: ai.offsetHeight || sheetH || halfSheetH(), lastY: e.clientY, lastT: performance.now(), v: 0, moved: false };
    ai.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!sd) return;
    const now = performance.now();
    sd.v = (sd.lastY - e.clientY) / Math.max(1, now - sd.lastT);      // px/ms, upward positive
    sd.lastY = e.clientY; sd.lastT = now;
    if (Math.abs(e.clientY - sd.y) > 4) sd.moved = true;
    const max = maxSheetH();
    let h = sd.h + (sd.y - e.clientY);
    if (h > max) h = max + (h - max) * 0.18;                           // elastic edge
    if (h < 1) h *= 0.18;
    if (isFull && h < max - 2) { isFull = false; ai.classList.remove("full"); }
    setH(clamp(h, 1, max));
  });
  const release = () => {
    if (!sd) return;
    const s = sd; sd = null;
    ai.classList.remove("dragging");
    if (!s.moved) return;
    const max = maxSheetH();
    const current = ai.offsetHeight || sheetH || halfSheetH();
    const projected = current + s.v * 180;
    if (projected < minOpenH() || s.v < -0.75) { closeSheet(); return; }
    // M3E 式“意图优先”释放：明显向上的 fling 不要求手指先拖到屏幕顶端。
    // 用户给把手一个向上的力，就把剩余行程交给 spring/height transition 完成。
    if (s.v > 0.52 || projected >= max * 0.86 || current >= max - 24) { setFull(true); return; }
    setFull(false);
    setH(clamp(current, minOpenH(), max - 1));
  };
  grip.addEventListener("pointerup", release);
  grip.addEventListener("pointercancel", release);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", () => clampSheetToViewport(false));

  // ---- resizable panels (wide + landscape) -------------------------------------------------------------------------
  const store = { get: (k, d) => { try { return Number(localStorage.getItem(k)) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } } };
  app.style.setProperty("--files-w", store.get("dfx.filesW", 264) + "px");
  app.style.setProperty("--ai-w", store.get("dfx.aiW", 380) + "px");
  function makeResizer(el, varName, key, dir, min, max) {
    let st = null;
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); st = { x: e.clientX, w: parseFloat(getComputedStyle(app).getPropertyValue(varName)) || 300 }; el.classList.add("dragging"); });
    el.addEventListener("pointermove", (e) => { if (st) app.style.setProperty(varName, clamp(st.w + dir * (e.clientX - st.x), min, max) + "px"); });
    const done = () => { if (!st) return; st = null; el.classList.remove("dragging"); store.set(key, parseFloat(getComputedStyle(app).getPropertyValue(varName))); };
    el.addEventListener("pointerup", done); el.addEventListener("pointercancel", done);
    el.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { const cur = parseFloat(getComputedStyle(app).getPropertyValue(varName)); const n = clamp(cur + dir * (e.key === "ArrowRight" ? 16 : -16), min, max); app.style.setProperty(varName, n + "px"); store.set(key, n); } });
  }
  makeResizer(resizers.r1, "--files-w", "dfx.filesW", 1, 180, 460);
  makeResizer(resizers.r2, "--ai-w", "dfx.aiW", -1, 280, 640);

  window.addEventListener("resize", updateMode);
  window.addEventListener("orientationchange", () => setTimeout(updateMode, 60));
  updateMode();
  return {
    openDrawer, closeDrawer, openSheetHalf, closeSheet, expandSheet,
    get mode() { return mode; },
  };
}
