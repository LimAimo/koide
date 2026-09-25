// Diffusion Renderer. Given a plan from the engine, it draws every atom as an absolutely-positioned span in an
// overlay above the editor and animates it from its old place to its new one, following the spec's phases:
//   A compute final layout  ->  B survivors start rearranging  ->  C removed code dissolves
//   D survivors arrive      ->  E room for new code has formed  ->  F new code materialises
// Positions are *measured* from hidden ghost copies of the old/new text (Range rects), so wide CJK glyphs and
// any monospace font line up exactly with the real editor text that replaces the overlay at the end.

import { KIND } from "./engine.js";
import { highlightLine, fillColoured } from "../../editor/highlight.js";
import { specFor } from "./packs.js";

const rnd = (a, b) => a + Math.random() * (b - a);
const MOVERS = new Set([KIND.LAYOUT_SHIFT, KIND.MOVE, KIND.GROUP_MOVE]);
const MARGIN = 240; // px of off-screen slack so text sliding in from outside the viewport still animates

export function playDiffusion(host, before, after, plan, opts = {}) {
  const doc = host.ownerDocument;
  const {
    lang = "", packs = {}, speed = 1, intensity = 1, density = 0.5, cinematic = false, viewport = null,
    plain = false, origin = null, fontCss = "", lineCss = "",   // 供 CodeMirror 等外部编辑器使用：不套用内置样式类，并指定文本区域的起点
  } = opts;
  const S = 1 / (Math.max(0.25, speed) * (cinematic ? 0.55 : 1));
  const spec = (kind) => specFor(packs[kind] || packs.all || "dissolve", kind);

  const bl = before.replace(/\r\n/g, "\n").split("\n"), al = after.replace(/\r\n/g, "\n").split("\n");
  const lines = { from: bl, to: al };

  // ---- ghosts for measuring + overlay ----------------------------------------------------------
  const mkGhost = (arr) => {
    const g = doc.createElement("div");
    g.className = (plain ? "" : "ce-code ") + "dfx-ghost";           // 必须与样式表里的 .dfx-ghost 一致，否则影子文字会显示出来
    if (plain) g.style.cssText = fontCss;
    for (const l of arr) {
      const d = doc.createElement("div");
      d.className = "ln";
      if (lineCss) d.style.cssText = lineCss;
      d.appendChild(doc.createTextNode(l === "" ? "\u200b" : l));
      g.appendChild(d);
    }
    return g;
  };
  const ghost = { from: mkGhost(bl), to: mkGhost(al) };
  const layer = doc.createElement("div");
  layer.className = "dfx-layer" + (plain ? "" : " ce-font");
  if (plain) layer.style.cssText = fontCss;
  if (origin) for (const e of [ghost.from, ghost.to, layer]) { e.style.left = origin.x + "px"; e.style.top = origin.y + "px"; }
  host.appendChild(ghost.from);
  host.appendChild(ghost.to);
  host.appendChild(layer);

  const geo = { from: ghost.from.getBoundingClientRect(), to: ghost.to.getBoundingClientRect() };
  const range = doc.createRange();
  let cw = 8, padLeft = 0;
  try {
    const cs = doc.defaultView.getComputedStyle(ghost.to);
    padLeft = parseFloat(cs.paddingLeft) || 0;
    const probe = doc.createElement("span");
    probe.textContent = "0000000000";
    probe.style.position = "absolute";
    layer.appendChild(probe);
    cw = probe.getBoundingClientRect().width / 10 || cw;
    probe.remove();
  } catch { /* keep defaults */ }

  const lineY = (side, line) => {
    const ln = ghost[side].children[line];
    return ln ? ln.getBoundingClientRect().top - geo[side].top : line * 20;
  };
  const pos = (side, line, col, len) => {
    const ln = ghost[side].children[line];
    let x = null;
    if (ln && ln.firstChild) {
      try {
        const n = ln.firstChild.length;
        range.setStart(ln.firstChild, Math.min(col, n));
        range.setEnd(ln.firstChild, Math.min(col + Math.max(len, 1), n));
        const r = range.getBoundingClientRect();
        if (r.width > 0) x = r.left - geo[side].left;
      } catch { /* fall through */ }
    }
    if (x === null) x = padLeft + col * cw;
    return { x, y: lineY(side, line) };
  };
  const inView = (...ys) => !viewport || ys.some((y) => y != null && y >= viewport.top - MARGIN && y <= viewport.bottom + MARGIN);

  // ---- element factory -------------------------------------------------------------------------
  const segCache = new Map();
  const segsFor = (t) => { if (!segCache.has(t)) segCache.set(t, highlightLine(t, lang)); return segCache.get(t); };
  const mkEl = (side, line, col, text, cls) => {
    const el = doc.createElement("span");
    el.className = "dfx-atom " + cls;
    const full = lines[side][line] ?? "";
    if (full.slice(col, col + text.length) === text) fillColoured(doc, el, full, col, col + text.length, segsFor(full));
    else el.textContent = text;
    layer.appendChild(el);
    return el;
  };
  const place = (el, x, y) => { el.style.transform = `translate(${x}px,${y}px)`; };

  const anims = [];
  let maxEnd = 0;
  const run = (el, keyframes, { duration, delay = 0, easing = "ease" }) => {
    const d = Math.max(1, duration), dl = Math.max(0, delay);
    anims.push(el.animate(keyframes, { duration: d, delay: dl, easing, fill: "both" }));
    maxEnd = Math.max(maxEnd, d + dl);
  };
  const fill = (tpl, v) => tpl.replace(/\{(sx|sy|ex|ey|rot)\}/g, (_, k) => String(v[k]));
  const framesOf = (sp, v) => sp.keyframes.map((f) => {
    const o = {};
    for (const [k, val] of Object.entries(f)) o[k] = typeof val === "string" ? fill(val, v) : val;
    return o;
  });

  // ---- rank atoms (0..1) inside each phase so staggering follows reading order --------------------
  const A = plan.atoms;
  const group = (pred) => A.filter(pred);
  const ranks = (list) => {
    const m = new Map(), first = new Map();
    list.forEach((a, i) => {
      if (a.group != null && first.has(a.group)) m.set(a, first.get(a.group));
      else { const r = list.length > 1 ? i / (list.length - 1) : 0; m.set(a, r); if (a.group != null) first.set(a.group, r); }
    });
    return m;
  };
  const movers = group((a) => MOVERS.has(a.kind)), dels = group((a) => a.kind === KIND.DELETE),
    ins = group((a) => a.kind === KIND.INSERT), trs = group((a) => a.kind === KIND.TRANSFORM);
  const rk = { move: ranks(movers), del: ranks(dels), ins: ranks(ins), tr: ranks(trs) };
  const mvSpec = spec("move"), gmSpec = spec("groupMove");
  const moveSpan = Math.max(mvSpec.duration + mvSpec.stagger, gmSpec.duration + gmSpec.stagger) * S;
  const insBase = Math.max(240 * S, 0.55 * moveSpan);
  const splitChars = density >= 0.66 && A.length < 300;

  // ---- per-kind drawing --------------------------------------------------------------------------
  const drawStatic = (a) => {
    const to = a.to;
    if (!inView(lineY("to", to.line))) return;
    const p = pos("to", to.line, to.col, a.text.length);
    place(mkEl("to", to.line, to.col, a.text, "dfx-keep"), p.x, p.y);
  };

  const drawMove = (a) => {
    const sp = a.kind === KIND.GROUP_MOVE ? gmSpec : mvSpec;
    const f = pos("from", a.from.line, a.from.col, a.text.length), t = pos("to", a.to.line, a.to.col, a.text.length);
    if (!inView(f.y, t.y)) { place(mkEl("to", a.to.line, a.to.col, a.text, "dfx-keep"), t.x, t.y); return; }
    const el = mkEl("to", a.to.line, a.to.col, a.text, a.kind === KIND.GROUP_MOVE ? "dfx-move dfx-group" : "dfx-move");
    place(el, t.x, t.y);
    run(el, [{ transform: `translate(${f.x}px,${f.y}px)` }, { transform: `translate(${t.x}px,${t.y}px)` }],
      { duration: sp.duration * S, delay: rk.move.get(a) * sp.stagger * S, easing: sp.easing });
  };

  const drawDissolveOrBuild = (a, isDelete) => {
    const side = isDelete ? "from" : "to", at = a[side];
    const p = pos(side, at.line, at.col, a.text.length);
    if (!inView(p.y)) return;
    const sp = spec(isDelete ? "delete" : "insert");
    const r = (isDelete ? rk.del : rk.ins).get(a);
    const base = isDelete ? 60 * S : insBase;
    const chars = splitChars && a.level === "token" && a.text.length <= 14 ? [...a.text] : [a.text];
    chars.forEach((chunk, i) => {
      const off = chars.length > 1 ? i * cw : 0;
      const el = mkEl(side, at.line, at.col + (chars.length > 1 ? i : 0), chunk, isDelete ? "dfx-del" : "dfx-ins");
      const dx = rnd(...(sp.drift?.x || [0, 0])) * intensity, dy = rnd(...(sp.drift?.y || [0, 0])) * intensity;
      const sx = p.x + off, sy = p.y;
      const v = isDelete
        ? { sx, sy, ex: sx + dx, ey: sy + dy, rot: Math.round(rnd(-14, 14) * intensity) }
        : { sx: sx + dx, sy: sy + dy, ex: sx, ey: sy, rot: Math.round(rnd(-8, 8) * intensity) };
      place(el, sx, sy);
      const kf = sp.keyframes ? framesOf(sp, v)
        : isDelete ? [{ opacity: 1, transform: `translate(${v.sx}px,${v.sy}px)` }, { opacity: 0, transform: `translate(${v.ex}px,${v.ey}px)` }]
          : [{ opacity: 0, transform: `translate(${v.sx}px,${v.sy}px)` }, { opacity: 1, transform: `translate(${v.ex}px,${v.ey}px)` }];
      run(el, kf, { duration: sp.duration * S, delay: base + (r * sp.stagger + (chars.length > 1 ? i * 14 : 0)) * S, easing: sp.easing });
    });
  };

  const drawTransform = (a) => {
    const sp = spec("transform");
    const f = pos("from", a.from.line, a.from.col, a.fromText.length), t = pos("to", a.to.line, a.to.col, a.text.length);
    if (!inView(f.y, t.y)) { place(mkEl("to", a.to.line, a.to.col, a.text, "dfx-keep"), t.x, t.y); return; }
    const dur = sp.duration * S, delay = 120 * S + rk.tr.get(a) * sp.stagger * S;
    const morph = (a.conf ?? 1) >= 0.7;                     // low confidence: plain cross-fade in place, no travel
    const oldEl = mkEl("from", a.from.line, a.from.col, a.fromText, "dfx-del"), newEl = mkEl("to", a.to.line, a.to.col, a.text, "dfx-ins");
    place(oldEl, f.x, f.y);
    place(newEl, t.x, t.y);
    const oldEnd = morph ? t : f;
    run(oldEl, [{ opacity: 1, filter: "blur(0px)", transform: `translate(${f.x}px,${f.y}px)` },
      { opacity: 0, filter: "blur(3px)", transform: `translate(${oldEnd.x}px,${oldEnd.y}px)` }], { duration: dur * 0.65, delay, easing: sp.easing });
    run(newEl, [{ opacity: 0, filter: "blur(3px)", transform: `translate(${t.x}px,${t.y}px)` },
      { opacity: 1, filter: "blur(0px)", transform: `translate(${t.x}px,${t.y}px)` }], { duration: dur * 0.65, delay: delay + dur * 0.35, easing: sp.easing });
  };

  for (const a of A) {
    if (a.kind === KIND.KEEP) drawStatic(a);
    else if (MOVERS.has(a.kind)) drawMove(a);
    else if (a.kind === KIND.DELETE) drawDissolveOrBuild(a, true);
    else if (a.kind === KIND.INSERT) drawDissolveOrBuild(a, false);
    else if (a.kind === KIND.TRANSFORM) drawTransform(a);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------
  let done = false, timer = null, resolveFn;
  const finished = new Promise((res) => { resolveFn = res; });
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    for (const a of anims) { try { a.cancel(); } catch { /* ignore */ } }
    layer.remove(); ghost.from.remove(); ghost.to.remove();
    resolveFn();
  };
  if (!anims.length) Promise.resolve().then(finish);
  else {
    Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(finish);
    timer = setTimeout(finish, maxEnd + 500);              // never leave the overlay stuck on screen
  }
  return { finished, cancel: finish, duration: maxEnd, atoms: anims.length };
}
