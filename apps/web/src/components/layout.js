// Layout controller. Three modes, chosen from the viewport (no page rebuild, just a class swap + CSS transitions):
//   wide  (>=900px)          files | editor | AI       resizable panels
//   land  (narrow landscape) editor | AI               files in a drawer
//   port  (portrait phone)   editor + draggable AI bottom sheet (30% / 60% / full), files in a drawer

import { pushLayer } from "./overlays.js";

const SNAPS = [0.3, 0.6, 1];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vh = () => (window.visualViewport ? window.visualViewport.height : window.innerHeight);

export function setupLayout({ app, files, ai, grip, scrim, resizers }) {
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
      applySnap(false);
    } else if (mode === "port") applySnap(false);
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
  let snap = 0, fullClose = null;
  const snapPx = (i) => Math.round(vh() * SNAPS[i]);
  function setH(px) { app.style.setProperty("--sheet-h", `${px}px`); }
  function applySnap() {
    if (mode !== "port") { app.style.removeProperty("--sheet-h"); ai.classList.remove("full"); return; }
    setH(snapPx(snap));
    ai.classList.toggle("full", snap === SNAPS.length - 1);
  }
  function snapTo(i, viaBack = false) {
    const wasFull = snap === SNAPS.length - 1;
    snap = clamp(i, 0, SNAPS.length - 1);
    applySnap();
    if (snap === SNAPS.length - 1 && !fullClose) fullClose = pushLayer(() => { fullClose = null; if (snap === SNAPS.length - 1) { snap = 1; applySnap(); } });
    else if (wasFull && snap !== SNAPS.length - 1 && fullClose && !viaBack) { const c = fullClose; fullClose = null; c(); }
  }
  function expandSheet(min = 1) { if (mode === "port" && snap < min) snapTo(min); }

  let sd = null;
  grip.addEventListener("pointerdown", (e) => {
    if (mode !== "port") return;
    grip.setPointerCapture && grip.setPointerCapture(e.pointerId);
    sd = { y: e.clientY, h: ai.offsetHeight, lastY: e.clientY, lastT: performance.now(), v: 0, moved: false };
    ai.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!sd) return;
    const now = performance.now();
    sd.v = (sd.lastY - e.clientY) / Math.max(1, now - sd.lastT);      // px/ms, upward positive
    sd.lastY = e.clientY; sd.lastT = now;
    if (Math.abs(e.clientY - sd.y) > 4) sd.moved = true;
    const min = snapPx(0) * 0.55, max = vh();
    let h = sd.h + (sd.y - e.clientY);
    if (h > max) h = max + (h - max) * 0.22;                           // elastic edges
    if (h < min) h = min - (min - h) * 0.22;
    setH(h);
  });
  const release = () => {
    if (!sd) return;
    const s = sd; sd = null;
    ai.classList.remove("dragging");
    if (!s.moved) { snapTo((snap + 1) % SNAPS.length); return; }       // tap cycles
    const projected = ai.offsetHeight + s.v * 220;
    let best = 0;
    SNAPS.forEach((_, i) => { if (Math.abs(snapPx(i) - projected) < Math.abs(snapPx(best) - projected)) best = i; });
    snapTo(best);
  };
  grip.addEventListener("pointerup", release);
  grip.addEventListener("pointercancel", release);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", () => applySnap());

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
  snapTo(0);
  return { openDrawer, closeDrawer, expandSheet, get mode() { return mode; } };
}
