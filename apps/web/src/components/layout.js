// Layout controller. Three modes, chosen from the viewport (no page rebuild, just a class swap + CSS transitions):
//   wide  (>=900px)          files | editor | AI       resizable panels
//   land  (narrow landscape) editor | AI               files in a drawer
//   port  (portrait phone)   editor + freely draggable AI bottom sheet, files in a drawer

import { pushLayer, hasLayers } from "./overlays.js";
import { velocityTracker, springTo, sheetDestination } from "../services/motion.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vh = () => (window.visualViewport ? window.visualViewport.height : window.innerHeight);

export function setupLayout({ app, files, ai, grip, scrim, resizers, onCloseAI }) {
  // ---- mode ------------------------------------------------------------------------------------------------
  let mode = "";
  function updateMode() {
    const w = window.innerWidth, hgt = window.innerHeight;
    const next = w >= 900 ? "wide" : w > hgt ? "land" : "port";
    if (next !== mode) {
      cancelSheetDrag(); stopSpring();
      endDrawerDrag({ type: "pointercancel" });
      setFull(false);
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
    if (mode === "wide" || e.pointerType === "mouse" || e.isPrimary === false || dr) return;
    const open = app.classList.contains("files-open");
    if (hasLayers() && !open) return;
    if (document.getElementById("overlay-root")?.contains(e.target)) return;
    if ((!open && e.clientX <= 22) || (open && files.contains(e.target))) {
      const w = files.offsetWidth;
      const rect = files.getBoundingClientRect();
      dr = { id: e.pointerId, x: e.clientX, y: e.clientY, velocity: velocityTracker(e.clientX), open, w, base: clamp(rect.left, -w, 0), active: false };
    }
  }, { passive: true });
  window.addEventListener("pointermove", (e) => {
    if (!dr || e.pointerId !== dr.id) return;
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    if (!dr.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) { dr.active = true; app.classList.add("files-dragging"); }
      else if (Math.abs(dy) > 12) { dr = null; return; }
      else return;
    }
    dr.velocity.add(e.clientX);
    const x = clamp(dr.base + dx, -dr.w, 0);
    dr.position = x;
    files.style.transform = `translateX(${x}px)`;
    scrim.style.opacity = String(1 + x / dr.w);
    scrim.style.pointerEvents = "auto";
  }, { passive: true });
  function endDrawerDrag(e = {}) {
    if (!dr || (e.pointerId != null && e.pointerId !== dr.id)) return;
    const d = dr; dr = null;
    if (!d.active) return;
    const x = d.position ?? d.base, v = d.velocity.value();
    app.classList.remove("files-dragging");
    files.style.transform = ""; scrim.style.opacity = ""; scrim.style.pointerEvents = "";
    const wantOpen = e.type === "pointercancel" ? d.open : v > 0.35 ? true : v < -0.35 ? false : x > -d.w / 2;
    if (wantOpen) { if (!d.open) openDrawer(); } else if (d.open) closeDrawer();
  }
  window.addEventListener("pointerup", endDrawerDrag);
  window.addEventListener("pointercancel", endDrawerDrag);

  // ---- AI bottom sheet (portrait) ---------------------------------------------------------------------------------
  // Closed is represented by the global aiVisible setting. Once visible, 50% is only the opening height:
  // dragging upward/downward leaves the sheet exactly where the user releases it, except near the two natural
  // boundaries (close and full-screen). Full-screen keeps its background edge-to-edge, but CSS pads interactive
  // content below Android/iOS's top safe area.
  let sheetH = null, isFull = false, fullClose = null, sd = null, cancelSpring = null;
  function stopSpring() { cancelSpring?.(); cancelSpring = null; ai.classList.remove("settling"); }
  const maxSheetH = () => Math.max(1, vh());
  const halfSheetH = () => Math.round(maxSheetH() * 0.5);
  const minOpenH = () => Math.round(maxSheetH() * 0.24);
  function setH(px) {
    sheetH = clamp(Math.round(px), 1, maxSheetH());
    app.style.setProperty("--sheet-h", `${sheetH}px`);
    grip.setAttribute("aria-valuenow", String(Math.round(sheetH / maxSheetH() * 100)));
  }
  function settle(target, velocity = 0) {
    stopSpring();
    const from = sheetH ?? ai.offsetHeight ?? halfSheetH();
    setFull(target === maxSheetH());
    ai.classList.add("settling");
    cancelSpring = springTo({ from, to: target, velocity, update: setH,
      complete: () => { cancelSpring = null; ai.classList.remove("settling"); } });
  }
  function syncFullLayer(viaBack = false) {
    if (isFull && !fullClose) {
      fullClose = pushLayer(() => {
        fullClose = null;
        if (isFull) {
          isFull = false;
          ai.classList.remove("full");
          settle(halfSheetH());
        }
      });
    } else if (!isFull && fullClose && !viaBack) {
      const c = fullClose; fullClose = null; c();
    }
  }
  function setFull(on, viaBack = false) {
    isFull = !!on;
    ai.classList.toggle("full", isFull);
    syncFullLayer(viaBack);
  }
  function openSheetHalf() {
    if (mode !== "port") return;
    cancelSheetDrag(); stopSpring();
    setFull(false);
    setH(halfSheetH());
  }
  function expandSheet(minRatio = 0.5) {
    if (mode !== "port") return;
    const target = Math.round(maxSheetH() * clamp(minRatio, 0.25, 1));
    if (isFull || (sheetH ?? 0) >= target) return;
    settle(target);
  }
  function closeSheet() {
    cancelSheetDrag(); stopSpring();
    setFull(false);
    onCloseAI && onCloseAI();
  }
  function hideSheet() { cancelSheetDrag(); stopSpring(); setFull(false); }
  function clampSheetToViewport(openAtHalfWhenUnset = false) {
    if (mode !== "port") return;
    cancelSheetDrag(); stopSpring();
    if (isFull) { setH(maxSheetH()); return; }
    if (sheetH == null) {
      if (openAtHalfWhenUnset) setH(halfSheetH());
      return;
    }
    setH(Math.min(sheetH, maxSheetH()));
  }

  grip.addEventListener("pointerdown", (e) => {
    if (mode !== "port" || app.classList.contains("ai-hidden") || sd || e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    stopSpring();
    grip.setPointerCapture && grip.setPointerCapture(e.pointerId);
    sd = { id: e.pointerId, y: e.clientY, h: ai.offsetHeight || sheetH || halfSheetH(), full: isFull, velocity: velocityTracker(-e.clientY), moved: false };
    ai.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!sd || e.pointerId !== sd.id) return;
    sd.velocity.add(-e.clientY);
    if (Math.abs(e.clientY - sd.y) > 4) sd.moved = true;
    const max = maxSheetH();
    let h = sd.h + (sd.y - e.clientY);
    // Keep the full-screen safe area until release; moving a finger must not move the header twice.
    setH(clamp(h, 1, max));
  });
  function cancelSheetDrag() {
    if (!sd) return;
    const s = sd; sd = null;
    ai.classList.remove("dragging");
    grip.releasePointerCapture?.(s.id);
    setFull(s.full); setH(s.h);
  }
  const release = (e) => {
    if (!sd || e.pointerId !== sd.id) return;
    if (e.type !== "pointerup") { cancelSheetDrag(); return; }
    const s = sd; sd = null;
    grip.releasePointerCapture?.(s.id);
    ai.classList.remove("dragging");
    if (!s.moved) return;
    const max = maxSheetH();
    const v = s.velocity.value();
    const target = sheetDestination(sheetH || halfSheetH(), v, max, s.full);
    if (!target) { closeSheet(); return; }
    settle(target, v);
  };
  grip.addEventListener("pointerup", release);
  grip.addEventListener("pointercancel", release);
  grip.addEventListener("lostpointercapture", release);
  grip.setAttribute("tabindex", "0");
  grip.setAttribute("aria-valuemin", "0"); grip.setAttribute("aria-valuemax", "100");
  grip.addEventListener("keydown", (e) => {
    if (mode !== "port" || !["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); cancelSheetDrag();
    if (e.key === "End") closeSheet();
    else settle(e.key === "Home" ? maxSheetH() : clamp((sheetH ?? halfSheetH()) + (e.key === "ArrowUp" ? 1 : -1) * maxSheetH() * 0.1, minOpenH(), maxSheetH()));
  });
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
    openDrawer, closeDrawer, openSheetHalf, closeSheet, hideSheet, expandSheet,
    get mode() { return mode; },
  };
}
