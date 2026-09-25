// CodeEditor: a dependency-free editor built as a highlighted line layer under a transparent <textarea>.
// Native selection handles, IME, spell-off, clipboard and the Android soft keyboard all keep working.
//
// ADAPTER INTERFACE (what a CodeMirror 6 / Monaco adapter must provide, see docs/editor-adapters.md):
//   setDocument({path,text,readOnly})  getValue()  applyExternal(after,{animate})  insertText(t)  indent(dir)
//   moveCaret(delta)  focus()  onChange / onSave callbacks  applySettings()  destroy()
// The Diffusion renderer only needs: the host element to overlay, the visible pixel range, and to hide the text.

import { h } from "../components/dom.js";
import { analyze } from "../animations/diffusion/engine.js";
import { playDiffusion } from "../animations/diffusion/renderer.js";
import { highlightLine, fillColoured, langOf } from "./highlight.js";
import { Minimap } from "./minimap.js";
import { settingsStore, reducedMotion } from "../services/store.js";

export class CodeEditor {
  constructor({ onChange, onSave, onFocus, onBlur, onSuggest, onFind } = {}) {
    this.onChange = onChange || (() => {});
    this.onSave = onSave || (() => {});
    this.onSuggest = onSuggest || (() => {});
    this.onFind = onFind || null;
    this._match = null;
    this._m = null;
    this._aux = 0;
    this.path = "";
    this.lang = "";
    this.text = "";
    this.lineTexts = [];
    this.lineEls = [];
    this.anim = null;
    this.readOnly = false;

    this.gutter = h("div", { class: "ce-gutter", "aria-hidden": "true" });
    this.code = h("div", { class: "ce-code" });
    this.input = h("textarea", {
      class: "ce-input", spellcheck: "false", autocapitalize: "off", autocomplete: "off", autocorrect: "off",
      wrap: "off", "aria-label": "代码编辑器", inputmode: "text",
    });
    this.marks = h("div", { class: "ce-marks", "aria-hidden": "true" });
    this.body = h("div", { class: "ce-body" }, this.marks, this.code, this.input);
    this.content = h("div", { class: "ce-content" }, this.gutter, this.body);
    this.el = h("div", { class: "ce ce-font" }, this.content);

    this.input.addEventListener("input", () => this._onInput());
    this.input.addEventListener("keydown", (e) => this._onKey(e));
    this.input.addEventListener("beforeinput", (e) => this._onBeforeInput(e));
    this.input.addEventListener("click", () => this._scheduleAux());
    this.input.addEventListener("keyup", () => this._scheduleAux());
    this._selectionChange = () => { if (document.activeElement === this.input) this._scheduleAux(); };
    document.addEventListener("selectionchange", this._selectionChange);
    this.minimap = null;
    this.zoom = 1;
    this._pinch = null;
    this._settingsOff = settingsStore.subscribe((st) => { this._m = null; this._applyMinimap(st.showMinimap); this._applyZoom(st); });
    this._applyMinimap(settingsStore.get().showMinimap);
    this._applyZoom(settingsStore.get());
    this._installZoomGestures();
    if (onFocus) this.input.addEventListener("focus", onFocus);
    if (onBlur) this.input.addEventListener("blur", onBlur);
  }

  // ---- document -------------------------------------------------------------------------------
  setDocument({ path = "", text = "", readOnly = false }) {
    this.cancelAnimation();
    this.path = path;
    this.lang = langOf(path);
    this.readOnly = readOnly;
    this.input.readOnly = readOnly;
    this.text = text;
    this.input.value = text;
    this.lineTexts = [];
    for (const el of this.lineEls) el.remove();
    this.lineEls = [];
    this._renderLines(text);
    this.el.scrollTop = 0;
    this.el.scrollLeft = 0;
  }

  getValue() { return this.input.value; }
  getSelectionText() { return this.input.value.slice(this.input.selectionStart, this.input.selectionEnd); }
  getScroll() { return { top: this.el.scrollTop, left: this.el.scrollLeft }; }
  setScroll(s) { this.el.scrollTop = s.top; this.el.scrollLeft = s.left; }
  focus() { this.input.focus(); }

  _renderLines(text) {
    const next = text.split("\n");
    const old = this.lineTexts;
    let s = 0;
    while (s < old.length && s < next.length && old[s] === next[s]) s++;
    let eo = old.length, en = next.length;
    while (eo > s && en > s && old[eo - 1] === next[en - 1]) { eo--; en--; }
    const anchor = this.lineEls[eo] || null;
    for (let i = s; i < eo; i++) this.lineEls[i].remove();
    const fresh = [];
    const big = next.length > 4000;                                 // skip colouring on huge files to stay responsive
    for (let i = s; i < en; i++) {
      const el = document.createElement("div");
      el.className = "ln";
      const line = next[i];
      if (line.length && !big) fillColoured(document, el, line, 0, line.length, highlightLine(line, this.lang));
      else if (line.length) el.textContent = line;
      this.code.insertBefore(el, anchor);
      fresh.push(el);
    }
    this.lineEls.splice(s, eo - s, ...fresh);
    this.lineTexts = next;
    if (this.minimap) this.minimap.schedule();
    if (old.length !== next.length) {
      this.gutter.textContent = Array.from({ length: next.length }, (_, i) => i + 1).join("\n");
    }
  }

  _onInput() {
    this.text = this.input.value;
    this._renderLines(this.text);
    this.onChange(this.text);
    this._scheduleAux();
  }

  // ---- key handling -----------------------------------------------------------------------------
  _onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this.onSave(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && this.onFind) { e.preventDefault(); this.onFind(); return; }
    if (this.readOnly) return;
    if (e.key === "Tab") { e.preventDefault(); this.indent(e.shiftKey ? -1 : 1); return; }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const ta = this.input, pos = ta.selectionStart, v = ta.value;
      const ls = v.lastIndexOf("\n", pos - 1) + 1;
      const lead = /^[ \t]*/.exec(v.slice(ls, pos))[0];
      const opener = /[{(\[:]\s*$/.test(v.slice(ls, pos));
      this.insertText("\n" + lead + (opener ? " ".repeat(settingsStore.get().tabWidth) : ""));
    }
  }

  /** Insert at the caret in a way that keeps the browser's native undo stack. */
  insertText(text) {
    const ta = this.input;
    if (this.readOnly) return;
    ta.focus();
    let ok = false;
    try { ok = document.execCommand && document.execCommand("insertText", false, text); } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  indent(dir) {
    const ta = this.input, unit = " ".repeat(settingsStore.get().tabWidth);
    const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    if (dir > 0 && a === b) return this.insertText(unit);
    const ls = v.lastIndexOf("\n", a - 1) + 1;
    let le = v.indexOf("\n", b);
    if (le < 0) le = v.length;
    const block = v.slice(ls, le).split("\n")
      .map((l) => (dir > 0 ? unit + l : l.replace(new RegExp(`^(?: {1,${unit.length}}|\\t)`), ""))).join("\n");
    ta.setSelectionRange(ls, le);
    this.insertText(block);
    ta.setSelectionRange(ls, ls + block.length);
  }

  moveCaret(delta) {
    const ta = this.input, p = Math.max(0, Math.min(ta.value.length, ta.selectionStart + delta));
    ta.focus();
    ta.setSelectionRange(p, p);
  }

  _applyMinimap(on) {
    if (on && !this.minimap) { this.minimap = new Minimap(this.el, () => this.text, () => this.lang); this.content.appendChild(this.minimap.box); this.minimap.schedule(); }
    else if (!on && this.minimap) { this.minimap.box.remove(); this.minimap = null; }
  }

  _applyZoom(st = settingsStore.get()) {
    const fs = Math.max(8, Math.min(40, st.fontSize * this.zoom));
    const lh = Math.round(fs * (st.density === "compact" ? 1.4 : 1.65));
    this.el.style.setProperty("--editor-fs", `${fs}px`);
    this.el.style.setProperty("--editor-lh", `${lh}px`);
    this._m = null;
  }

  _installZoomGestures() {
    const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    this._touchStart = (e) => { if (e.touches.length === 2) this._pinch = { d: Math.max(1, dist(e.touches)), zoom: this.zoom }; };
    this._touchMove = (e) => {
      if (!this._pinch || e.touches.length !== 2) return;
      e.preventDefault();
      this.zoom = Math.max(.65, Math.min(2.4, this._pinch.zoom * dist(e.touches) / this._pinch.d));
      this._applyZoom();
    };
    this._touchEnd = (e) => { if (e.touches.length < 2) this._pinch = null; };
    this._wheelZoom = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoom = Math.max(.65, Math.min(2.4, this.zoom * (e.deltaY < 0 ? 1.08 : .92)));
      this._applyZoom();
    };
    this.el.addEventListener("touchstart", this._touchStart, { passive: true });
    this.el.addEventListener("touchmove", this._touchMove, { passive: false });
    this.el.addEventListener("touchend", this._touchEnd, { passive: true });
    this.el.addEventListener("touchcancel", this._touchEnd, { passive: true });
    this.el.addEventListener("wheel", this._wheelZoom, { passive: false });
  }

  applySettings() { this._applyZoom(); }

  // ---- AI / external edits with Diffusion ----------------------------------------------------------
  cancelAnimation() {
    if (this.anim) { this.anim.cancel(); this.anim = null; }
    this.el.classList.remove("dfx-playing");
  }

  /**
   * Replace the document with `after`. When `animate` is true and the change is worth animating, the old code
   * flows into the new code. The real text is already final underneath; the overlay is purely visual.
   */
  async applyExternal(after, { animate = false } = {}) {
    const before = this.text;
    if (before === after) return { plan: null };
    this.cancelAnimation();
    const keepSel = [this.input.selectionStart, this.input.selectionEnd];
    const s = settingsStore.get();
    const plan = animate ? analyze(before, after) : null;

    this.text = after;
    this.input.value = after;
    this._renderLines(after);
    try { this.input.setSelectionRange(Math.min(keepSel[0], after.length), Math.min(keepSel[1], after.length)); } catch { /* not focused */ }

    if (!plan || !plan.changed) return { plan };
    if (reducedMotion(s)) { this._crossfade(120); return { plan }; }
    if (plan.granularity === "simplified") { this._crossfade(320); return { plan }; }

    const a = s.anim;
    const packs = a.mode === "manual" ? a.manual : { all: a.pack };
    this.el.classList.add("dfx-playing");
    this.anim = playDiffusion(this.body, before, after, plan, {
      lang: this.lang, packs, speed: a.speed, intensity: a.intensity, density: a.density, cinematic: a.cinematic,
      viewport: { top: this.el.scrollTop, bottom: this.el.scrollTop + this.el.clientHeight },
    });
    const mine = this.anim;
    await mine.finished;
    if (this.anim === mine) { this.anim = null; this.el.classList.remove("dfx-playing"); }
    return { plan };
  }

  _crossfade(ms) {
    if (!this.code.animate) return;
    this.code.animate([{ opacity: 0.25, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0)" }], { duration: ms, easing: "ease-out" });
  }


  // ---- 括号 / 引号自动补全（走 beforeinput，安卓输入法下 keydown 不可靠）------------------------------------------------
  _onBeforeInput(e) {
    if (this.readOnly || e.isComposing) return;
    const ta = this.input, a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
    const CLOSERS = new Set([")", "]", "}", '"', "'", "`"]);
    if (e.inputType === "insertText" && e.data && e.data.length === 1) {
      const ch = e.data, next = v[b] || "", prev = v[a - 1] || "";
      if (CLOSERS.has(ch) && a === b && next === ch) { e.preventDefault(); this.moveCaret(1); return; }        // 直接跳过已有的闭合符
      if (ch in PAIRS) {
        if (a !== b) { e.preventDefault(); const sel = v.slice(a, b); this.insertText(ch + sel + PAIRS[ch]); ta.setSelectionRange(a + 1, a + 1 + sel.length); return; }   // 包裹选中内容
        const quote = ch === '"' || ch === "'" || ch === "`";
        if (quote && /[\p{L}\p{N}_]/u.test(prev)) return;                                                     // don't 这类不补全
        if (/[\p{L}\p{N}_]/u.test(next)) return;
        e.preventDefault();
        this.insertText(ch + PAIRS[ch]);
        this.moveCaret(-1);
        return;
      }
    }
    if (e.inputType === "deleteContentBackward" && a === b && a > 0 && PAIRS[v[a - 1]] && PAIRS[v[a - 1]] === v[a]) {
      e.preventDefault();
      ta.setSelectionRange(a - 1, a + 1);
      this.insertText("");
      return;
    }
    if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", a - 1) + 1;
      const lead = /^[ \t]*/.exec(v.slice(ls, a))[0];
      this.insertText("\n" + lead + (/[{(\[:]\s*$/.test(v.slice(ls, a)) ? " ".repeat(settingsStore.get().tabWidth) : ""));
    }
  }

  // ---- 度量、括号匹配、词语补全 --------------------------------------------------------------------------------------
  _metrics() {
    if (this._m) return this._m;
    let cw = 8, padLeft = 12, padTop = 8, lh = 23;
    try {
      const probe = document.createElement("span");
      probe.textContent = "0000000000";
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      this.code.appendChild(probe);
      cw = probe.getBoundingClientRect().width / 10 || cw;
      probe.remove();
      const cs = getComputedStyle(this.code);
      padLeft = parseFloat(cs.paddingLeft) || padLeft;
      padTop = parseFloat(cs.paddingTop) || padTop;
      lh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lh")) || lh;
    } catch { /* 使用默认值 */ }
    this._m = { cw, padLeft, padTop, lh };
    return this._m;
  }

  _cells(str) {
    let n = 0;
    const tab = settingsStore.get().tabWidth;
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (ch === "\t") n += tab - (n % tab);
      else n += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
    }
    return n;
  }

  _box(offset, len, cls) {
    const v = this.input.value, m = this._metrics();
    const ls = v.lastIndexOf("\n", offset - 1) + 1;
    let line = 0;
    for (let i = v.indexOf("\n"); i !== -1 && i < offset; i = v.indexOf("\n", i + 1)) line++;
    const x = m.padLeft + this._cells(v.slice(ls, offset)) * m.cw;
    const le = v.indexOf("\n", offset);
    const text = v.slice(offset, Math.min(offset + len, le === -1 ? v.length : le));
    const box = document.createElement("div");
    box.className = "ce-mk " + cls;
    box.style.cssText = `left:${x}px;top:${m.padTop + line * m.lh}px;width:${Math.max(1, this._cells(text)) * m.cw}px;height:${m.lh}px`;
    this.marks.appendChild(box);
  }

  _bracketPair() {
    const v = this.input.value, pos = this.input.selectionStart;
    if (this.input.selectionEnd !== pos || v.length > 200000) return null;
    const OPEN = "([{", CLOSE = ")]}";
    for (const p of [pos - 1, pos]) {
      const c = v[p];
      if (!c) continue;
      let i = OPEN.indexOf(c);
      if (i >= 0) {
        let depth = 0;
        for (let j = p; j < Math.min(v.length, p + 20000); j++) { if (v[j] === c) depth++; else if (v[j] === CLOSE[i] && --depth === 0) return [p, j]; }
        return null;
      }
      i = CLOSE.indexOf(c);
      if (i >= 0) {
        let depth = 0;
        for (let j = p; j >= Math.max(0, p - 20000); j--) { if (v[j] === c) depth++; else if (v[j] === OPEN[i] && --depth === 0) return [j, p]; }
        return null;
      }
    }
    return null;
  }

  _drawMarks() {
    while (this.marks.firstChild) this.marks.removeChild(this.marks.firstChild);
    if (this._match) this._box(this._match.idx, this._match.len, "match");
    const pair = this._bracketPair();
    if (pair) for (const p of pair) this._box(p, 1, "bracket");
  }

  _words() {
    if (this._wordsFor === this.text) return this._wordFreq;
    const freq = new Map();
    for (const m of this.text.slice(0, 300000).matchAll(/[\p{L}\p{N}_$]{3,}/gu)) freq.set(m[0], (freq.get(m[0]) || 0) + 1);
    this._wordsFor = this.text;
    this._wordFreq = freq;
    return freq;
  }

  suggestions() {
    const ta = this.input, pos = ta.selectionStart;
    if (this.readOnly || ta.selectionEnd !== pos) return { prefix: "", words: [] };
    const m = /[\p{L}\p{N}_$]{2,}$/u.exec(ta.value.slice(Math.max(0, pos - 40), pos));
    if (!m) return { prefix: "", words: [] };
    const prefix = m[0];
    const words = [...this._words()].filter(([w]) => w !== prefix && w.startsWith(prefix)).sort((x, y) => y[1] - x[1] || x[0].length - y[0].length).slice(0, 6).map(([w]) => w);
    return { prefix, words };
  }

  applySuggestion(word) {
    const { prefix } = this.suggestions();
    const ta = this.input, pos = ta.selectionStart;
    if (!prefix) return;
    ta.setSelectionRange(pos - prefix.length, pos);
    this.insertText(word);
  }

  _scheduleAux() {
    if (this._aux) return;
    this._aux = requestAnimationFrame(() => {
      this._aux = 0;
      this._drawMarks();
      const sg = this.suggestions();
      this.onSuggest(sg.words, (w) => this.applySuggestion(w));
    });
  }

  // ---- 查找 / 替换 ----------------------------------------------------------------------------------------------------------
  _scrollToOffset(offset) {
    const v = this.input.value, m = this._metrics();
    let line = 0;
    for (let i = v.indexOf("\n"); i !== -1 && i < offset; i = v.indexOf("\n", i + 1)) line++;
    const y = m.padTop + line * m.lh;
    if (y < this.el.scrollTop || y > this.el.scrollTop + this.el.clientHeight - m.lh * 2) this.el.scrollTop = Math.max(0, y - this.el.clientHeight / 3);
  }

  countMatches(query, caseSensitive = false) {
    if (!query) return 0;
    const hay = caseSensitive ? this.input.value : this.input.value.toLowerCase(), needle = caseSensitive ? query : query.toLowerCase();
    let n = 0;
    for (let i = hay.indexOf(needle); i !== -1 && n < 5000; i = hay.indexOf(needle, i + Math.max(1, needle.length))) n++;
    return n;
  }

  /** 选中下一个（或上一个）匹配并滚动到可见位置，到头后绕回。返回 {index, count}，没有匹配返回 null。 */
  find(query, { caseSensitive = false, backwards = false } = {}) {
    const ta = this.input, count = this.countMatches(query, caseSensitive);
    if (!count) { this._match = null; this._drawMarks(); return null; }
    const hay = caseSensitive ? ta.value : ta.value.toLowerCase(), needle = caseSensitive ? query : query.toLowerCase();
    let idx = backwards ? (ta.selectionStart > 0 ? hay.lastIndexOf(needle, ta.selectionStart - 1) : -1) : hay.indexOf(needle, ta.selectionEnd);
    if (idx === -1) idx = backwards ? hay.lastIndexOf(needle) : hay.indexOf(needle);
    ta.setSelectionRange(idx, idx + needle.length);
    this._match = { idx, len: needle.length };
    this._scrollToOffset(idx);
    this._drawMarks();
    let before = 0;
    for (let i = hay.indexOf(needle); i !== -1 && i < idx; i = hay.indexOf(needle, i + Math.max(1, needle.length))) before++;
    return { index: before + 1, count };
  }

  replaceCurrent(query, replacement, caseSensitive = false) {
    const ta = this.input, sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && (caseSensitive ? sel === query : sel.toLowerCase() === query.toLowerCase())) this.insertText(replacement);
    return this.find(query, { caseSensitive });
  }

  replaceAll(query, replacement, caseSensitive = false) {
    if (!query) return 0;
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
    const before = this.input.value;
    let n = 0;
    const next = before.replace(re, () => { n++; return replacement; });
    if (n) { this.input.setSelectionRange(0, before.length); this.insertText(next); }
    this._match = null;
    this._drawMarks();
    return n;
  }

  clearFind() { this._match = null; this._drawMarks(); }

  destroy() {
    this.cancelAnimation();
    this._settingsOff?.();
    document.removeEventListener?.("selectionchange", this._selectionChange);
    if (this.el.removeEventListener) {
      this.el.removeEventListener("touchstart", this._touchStart);
      this.el.removeEventListener("touchmove", this._touchMove);
      this.el.removeEventListener("touchend", this._touchEnd);
      this.el.removeEventListener("touchcancel", this._touchEnd);
      this.el.removeEventListener("wheel", this._wheelZoom);
    }
    this.minimap?.box?.remove?.();
    this.el.remove();
  }
}
