// CodeMirror 6 适配器：实现和内置 CodeEditor 相同的接口（见 docs/editor-adapters.md），所以界面层不用关心当前用的是哪个编辑器。
//
// 相比内置编辑器多出来的能力：代码折叠、按语言补全、真正的语法高亮（多行注释和字符串）、更完善的输入法与触屏支持、
// 括号匹配与自动补全、上百种语言（按需加载）。
// 注意：这份适配器需要联网执行 `pnpm install` 后才能构建；它编写时没有条件在真实浏览器里运行过，首次使用请留意。

import { EditorState, Compartment, Annotation } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, indentMore, indentLess } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap, LanguageDescription, indentUnit } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completeAnyWord } from "@codemirror/autocomplete";
import { highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { analyze } from "../../../apps/web/src/animations/diffusion/engine.js";
import { playDiffusion } from "../../../apps/web/src/animations/diffusion/renderer.js";
import { langOf } from "../../../apps/web/src/editor/highlight.js";

/** 标记「由 AI 或撤销引起的整体替换」：这类事务不算用户输入，也不触发 onChange。 */
const External = Annotation.define();

// 颜色全部引用界面的 CSS 变量，所以换主题色时编辑器会一起变；动画覆盖层用的也是同一组变量，两者颜色一致。
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.operatorKeyword], color: "var(--tk-kw)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--tk-str)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--tk-num)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--tk-com)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--tk-fn)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--tk-type)" },
  { tag: t.invalid, color: "var(--error)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--on-surface)", backgroundColor: "var(--surface)", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "var(--fs)", lineHeight: "var(--lh)", overscrollBehavior: "contain" },
  ".cm-content": { caretColor: "var(--primary)", padding: "8px 0 var(--ce-bottom, 45vh)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--outline)", border: "none", borderRight: "1px solid var(--outline-variant)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--primary) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--on-surface)" },
  ".cm-cursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--primary) 32%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--primary) 30%, transparent)", outline: "1px solid color-mix(in oklab, var(--primary) 60%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--surface-2)", border: "1px solid var(--outline-variant)", color: "var(--on-surface)", borderRadius: "8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--secondary-container)", color: "var(--on-secondary-container)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "none", color: "var(--on-surface-variant)" },
});

class CM6Editor {
  constructor(o) {
    this.o = o;
    this.isCM6 = true;
    this.path = "";
    this.readOnly = false;
    this.anim = null;
    this._langToken = 0;
    this.langComp = new Compartment();
    this.roComp = new Compartment();
    this.tabComp = new Compartment();
    const s = (o.getSettings && o.getSettings()) || { tabWidth: 2 };

    this.exts = [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(highlight), bracketMatching(), closeBrackets(),
      autocompletion(), highlightActiveLine(), highlightSelectionMatches(),
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),          // 任何语言都能补全文件里出现过的词
      keymap.of([
        { key: "Mod-s", run: () => { o.onSave && o.onSave(); return true; } },
        { key: "Mod-f", run: () => { if (o.onFind) { o.onFind(); return true; } return false; } },   // 查找栏由界面层统一提供
        ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      this.tabComp.of([EditorState.tabSize.of(s.tabWidth), indentUnit.of(" ".repeat(s.tabWidth))]),
      this.langComp.of([]),
      this.roComp.of([]),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) o.onChange && o.onChange(u.state.doc.toString());
      }),
      EditorView.domEventHandlers({ focus: () => { o.onFocus && o.onFocus(); }, blur: () => { o.onBlur && o.onBlur(); } }),
    ];
    this.el = document.createElement("div");
    this.el.className = "cm-host";
    this.view = new EditorView({ state: this._state(""), parent: this.el });
  }

  _state(text) { return EditorState.create({ doc: text, extensions: this.exts }); }

  // ---- 文档 -----------------------------------------------------------------------------------------------------------
  setDocument({ path = "", text = "", readOnly = false }) {
    this.cancelAnimation();
    this.path = path;
    this.readOnly = readOnly;
    this.view.setState(this._state(text));                                         // 换文件时同时清空撤销历史
    this.view.dispatch({ effects: this.roComp.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
    this._loadLang(path);
    this.view.scrollDOM.scrollTop = 0;
    this.view.scrollDOM.scrollLeft = 0;
  }

  _loadLang(path) {
    const desc = LanguageDescription.matchFilename(languages, path.split("/").pop() || "");
    const token = ++this._langToken;
    if (!desc) return;
    desc.load().then((support) => { if (token === this._langToken) this.view.dispatch({ effects: this.langComp.reconfigure(support) }); }).catch(() => {});
  }

  getValue() { return this.view.state.doc.toString(); }
  getSelectionText() { const r = this.view.state.selection.main; return this.view.state.sliceDoc(r.from, r.to); }
  getScroll() { return { top: this.view.scrollDOM.scrollTop, left: this.view.scrollDOM.scrollLeft }; }
  setScroll(s) { this.view.scrollDOM.scrollTop = s.top; this.view.scrollDOM.scrollLeft = s.left; }
  focus() { this.view.focus(); }

  insertText(text) { if (!this.readOnly) this.view.dispatch(this.view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" }); }
  indent(dir) { (dir > 0 ? indentMore : indentLess)(this.view); }
  moveCaret(delta) {
    const head = this.view.state.selection.main.head, n = this.view.state.doc.length;
    this.view.dispatch({ selection: { anchor: Math.max(0, Math.min(n, head + delta)) }, scrollIntoView: true });
    this.view.focus();
  }

  // ---- 查找 / 替换（界面层的查找栏调用）------------------------------------------------------------------------------------
  countMatches(q, cs = false) { return this._all(q, cs).length; }
  _all(q, cs) {
    if (!q) return [];
    const doc = this.getValue(), hay = cs ? doc : doc.toLowerCase(), needle = cs ? q : q.toLowerCase(), out = [];
    for (let i = hay.indexOf(needle); i !== -1 && out.length < 5000; i = hay.indexOf(needle, i + Math.max(1, needle.length))) out.push(i);
    return out;
  }
  find(q, { caseSensitive = false, backwards = false } = {}) {
    const all = this._all(q, caseSensitive);
    if (!all.length) return null;
    const sel = this.view.state.selection.main;
    let idx = backwards ? [...all].reverse().find((i) => i < sel.from) : all.find((i) => i >= sel.to);
    if (idx === undefined) idx = backwards ? all[all.length - 1] : all[0];
    this.view.dispatch({ selection: { anchor: idx, head: idx + q.length }, scrollIntoView: true });
    return { index: all.indexOf(idx) + 1, count: all.length };
  }
  replaceCurrent(q, r, cs = false) {
    const sel = this.getSelectionText();
    if (sel && (cs ? sel === q : sel.toLowerCase() === q.toLowerCase())) this.view.dispatch(this.view.state.replaceSelection(r), { userEvent: "input.replace" });
    return this.find(q, { caseSensitive: cs });
  }
  replaceAll(q, r, cs = false) {
    const all = this._all(q, cs);
    if (all.length) this.view.dispatch({ changes: all.map((i) => ({ from: i, to: i + q.length, insert: r })), userEvent: "input.replace" });
    return all.length;
  }
  clearFind() { /* CodeMirror 的选区高亮已经足够，无需额外标记 */ }

  // ---- AI / 撤销引起的修改：整体替换，并播放 Diffusion 动画 -------------------------------------------------------------------
  cancelAnimation() {
    if (this.anim) { this.anim.cancel(); this.anim = null; }
    this.view.dom.classList.remove("dfx-playing-cm");
  }

  async applyExternal(after, { animate = false } = {}) {
    const before = this.getValue();
    if (before === after) return { plan: null };
    this.cancelAnimation();
    const s = (this.o.getSettings && this.o.getSettings()) || {}, a = s.anim || {};
    const plan = animate ? analyze(before, after) : null;
    const sel = this.view.state.selection.main;
    // 整个修改是一个事务：用户按一次撤销就能回退整次 AI 修改
    this.view.dispatch({
      changes: { from: 0, to: before.length, insert: after },
      selection: { anchor: Math.min(sel.anchor, after.length), head: Math.min(sel.head, after.length) },
      annotations: External.of(true), userEvent: "input.diffusion",
    });
    if (!plan || !plan.changed) return { plan };
    if (this.o.isReducedMotion && this.o.isReducedMotion()) return { plan };
    if (plan.granularity === "simplified") { this.view.contentDOM.animate && this.view.contentDOM.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 320 }); return { plan }; }

    const scroller = this.view.scrollDOM, content = this.view.contentDOM, cs = getComputedStyle(content);
    const lineEl = content.querySelector(".cm-line"), lcs = lineEl ? getComputedStyle(lineEl) : null;
    const gutters = scroller.querySelector(".cm-gutters");
    const origin = { x: gutters ? gutters.offsetWidth : 0, y: content.offsetTop + (parseFloat(cs.paddingTop) || 0) };
    this.view.dom.classList.add("dfx-playing-cm");
    this.anim = playDiffusion(scroller, before, after, plan, {
      plain: true, origin,
      fontCss: `font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:${cs.lineHeight};tab-size:${cs.tabSize};white-space:pre`,
      lineCss: `padding-left:${lcs ? lcs.paddingLeft : "6px"};height:${cs.lineHeight}`,
      lang: langOf(this.path), packs: a.mode === "manual" ? a.manual : { all: a.pack },
      speed: a.speed, intensity: a.intensity, density: a.density, cinematic: a.cinematic,
      viewport: { top: scroller.scrollTop - origin.y, bottom: scroller.scrollTop + scroller.clientHeight - origin.y },
    });
    const mine = this.anim;
    await mine.finished;
    if (this.anim === mine) { this.anim = null; this.view.dom.classList.remove("dfx-playing-cm"); }
    return { plan };
  }

  destroy() { this.cancelAnimation(); this.view.destroy(); this.el.remove(); }
}

export function createCM6Editor(options = {}) { return new CM6Editor(options); }
export const version = "0.5.0";
