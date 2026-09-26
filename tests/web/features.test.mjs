import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { installFakeDom } from "./fake-dom.mjs";

installFakeDom();
const { TermScreen } = await import("../../apps/web/src/components/ansi.js");
const { sha256Sync } = await import("../../apps/web/src/services/sha256.js");
const { CodeEditor } = await import("../../apps/web/src/editor/code-editor.js");
const { renderMarkdown } = await import("../../apps/web/src/components/markdown.js");

test("sha256 纯 JS 实现与 Node crypto 结果一致（含边界长度）", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100000]) {
    const bytes = crypto.randomBytes(len);
    assert.equal(sha256Sync(new Uint8Array(bytes)), crypto.createHash("sha256").update(bytes).digest("hex"), "长度 " + len);
  }
  assert.equal(sha256Sync(new TextEncoder().encode("你好")), crypto.createHash("sha256").update("你好").digest("hex"));
});

test("终端屏幕：回车覆盖、退格、清行、颜色、光标移动", () => {
  const t = new TermScreen();
  t.write("hello\rHE");
  assert.equal(t.text(), "HEllo");
  t.write("\r\n进度 10%\r进度 99%\x1b[K\r\n");
  assert.equal(t.text().split("\n")[1], "进度 99%");
  t.write("abc\b\b\x1b[K");
  assert.equal(t.text().split("\n")[2], "a");
  t.write("\r\n\x1b[31mred\x1b[0m plain\x1b[1;38;5;196mX\x1b[38;2;1;2;3mY");
  const last = t.lines[t.row];
  assert.equal(last[0].s.fg, 1);
  assert.equal(last[3].s.fg, undefined);
  assert.equal(last[9].s.bold, true);
  assert.match(last[9].s.fg, /^rgb\(/);
  assert.equal(last[10].s.fg, "rgb(1,2,3)");
});

test("终端屏幕：转义序列可以被拆在两个数据块之间，OSC 标题被丢弃", () => {
  const t = new TermScreen();
  t.write("a\x1b[3"); t.write("2mb\x1b]0;标题\x07c");
  assert.equal(t.text(), "abc");
  assert.equal(t.lines[0][1].s.fg, 2);
  t.write("\x1b[?2004h\x1b(Bok\x1b[2J");
  assert.equal(t.text(), "");
});

test("终端屏幕：超过上限的旧行会被丢弃", () => {
  const t = new TermScreen(5);
  for (let i = 0; i < 20; i++) t.write(`第${i}行\r\n`);
  assert.equal(t.lines.length <= 5, true);
  assert.match(t.text(), /第19行/);
});

const key = (ed, ch, extra = {}) => { let stopped = false; ed._onBeforeInput({ inputType: "insertText", data: ch, isComposing: false, preventDefault() { stopped = true; }, ...extra }); return stopped; };
const setup = (text, caret) => { const ed = new CodeEditor({}); ed.setDocument({ path: "a.js", text }); ed.input.setSelectionRange(caret, caret); return ed; };

test("自动补全括号：补全、跳过闭合符、成对删除、包裹选区", () => {
  let ed = setup("", 0);
  assert.equal(key(ed, "("), true);
  assert.equal(ed.input.value, "()");
  assert.equal(ed.input.selectionStart, 1);
  assert.equal(key(ed, ")"), true);                                       // 输入 ) 时直接跳过已有的
  assert.equal(ed.input.value, "()");
  assert.equal(ed.input.selectionStart, 2);
  ed = setup("()", 1);
  ed._onBeforeInput({ inputType: "deleteContentBackward", isComposing: false, preventDefault() {} });
  assert.equal(ed.input.value, "");                                       // 退格同时删掉一对
  ed = setup("abc", 0); ed.input.setSelectionRange(0, 3);
  key(ed, '"');
  assert.equal(ed.input.value, '"abc"');
  ed = setup("don", 3);
  assert.equal(key(ed, "'"), false);                                      // 单词后的引号不自动补全
  ed = setup("x", 0);
  assert.equal(key(ed, "["), false);                                      // 紧挨着单词字符时不补全
});

test("输入法组字期间不干预", () => {
  const ed = setup("", 0);
  assert.equal(key(ed, "(", { isComposing: true }), false);
});

test("换行自动缩进（走 beforeinput，适配安卓输入法）", () => {
  const ed = setup("if (x) {", 8);
  ed._onBeforeInput({ inputType: "insertLineBreak", isComposing: false, preventDefault() {} });
  assert.equal(ed.input.value, "if (x) {\n  ");
});

test("括号匹配", () => {
  const ed = setup("f(a[1], {b})", 1);
  assert.deepEqual(ed._bracketPair(), [1, 11]);
  ed.input.setSelectionRange(11, 11);
  assert.deepEqual(ed._bracketPair(), [8, 10]);                          // 光标前一个字符是 }，优先匹配它
  ed.input.setSelectionRange(12, 12);
  assert.deepEqual(ed._bracketPair(), [1, 11]);
  ed.input.setSelectionRange(4, 4);
  assert.deepEqual(ed._bracketPair(), [3, 5]);
});

test("词语补全：按出现频率排序，排除自身", () => {
  const ed = setup("function fooBar() {}\nfooBar(); fooBaz();\nfo", 0);
  ed.input.setSelectionRange(ed.input.value.length, ed.input.value.length);
  assert.deepEqual(ed.suggestions(), { prefix: "fo", words: ["fooBar", "fooBaz"] });
  ed.applySuggestion("fooBar");
  assert.ok(ed.input.value.endsWith("\nfooBar"));
  assert.deepEqual(setup("x", 1).suggestions().words, []);
});

test("查找与替换", () => {
  const ed = setup("Foo foo FOO bar", 0);
  assert.equal(ed.countMatches("foo"), 3);
  assert.equal(ed.countMatches("foo", true), 1);
  assert.deepEqual(ed.find("foo"), { index: 1, count: 3 });
  assert.deepEqual([ed.input.selectionStart, ed.input.selectionEnd], [0, 3]);
  assert.deepEqual(ed.find("foo"), { index: 2, count: 3 });
  ed.find("foo"); assert.deepEqual(ed.find("foo"), { index: 1, count: 3 });   // 绕回开头
  assert.deepEqual(ed.find("foo", { backwards: true }), { index: 3, count: 3 });
  assert.equal(ed.find("不存在"), null);
  ed.find("bar");
  ed.replaceCurrent("bar", "酒吧");
  assert.equal(ed.input.value, "Foo foo FOO 酒吧");
  assert.equal(ed.replaceAll("foo", "x"), 3);
  assert.equal(ed.input.value, "x x x 酒吧");
  assert.equal(ed.replaceAll("a.b", "z"), 0);                                // 特殊字符按字面匹配
});


test("编辑器双指缩放只改变编辑器字号比例", () => {
  const ed = setup("const veryLongLine = 'abcdefghijklmnopqrstuvwxyz';", 0);
  const before = ed.zoom;
  ed._touchStart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
  let prevented = false;
  ed._touchMove({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 160, clientY: 0 }], preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(ed.zoom > before, `${ed.zoom} should be larger than ${before}`);
  assert.match(ed.el.style.getPropertyValue("--editor-fs"), /px$/);
  ed.destroy();
});

test("Markdown：ATX/Setext 标题、GFM 表格、任务列表和两种围栏代码都能安全渲染", () => {
  const root = document.createElement("div");
  root.appendChild(renderMarkdown(`# 一级标题\n\n二级标题\n---\n\n- [x] 完成\n- [ ] 待办\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n~~~js\nconst x = 1;\n~~~\n\n    indented()`));
  assert.equal(root.querySelectorAll("h1").length, 1);
  assert.equal(root.querySelectorAll("h2").length, 1);
  assert.equal(root.querySelectorAll("table").length, 1);
  assert.equal(root.querySelectorAll(".task-item").length, 2);
  assert.equal(root.querySelectorAll("pre").length, 2);
  assert.match(root.textContent, /一级标题.*二级标题.*const x = 1.*indented/s);
});


test("正式编辑器固定为 CodeMirror 6，原生构建会先生成编辑器产物", () => {
  const factory = fs.readFileSync(new URL("../../apps/web/src/services/editor-factory.js", import.meta.url), "utf8");
  const pane = fs.readFileSync(new URL("../../apps/web/src/components/editor-pane.js", import.meta.url), "utf8");
  const config = JSON.parse(fs.readFileSync(new URL("../../apps/native/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.doesNotMatch(factory, /catch\s*\(.*=>\s*null/);
  assert.doesNotMatch(pane, /new CodeEditor/);
  assert.match(config.build.beforeBuildCommand, /editor-cm6/);
  assert.match(config.build.beforeDevCommand, /editor-cm6/);
});

test("手机 AI 全屏保留状态栏安全区且使用自由高度 bottom sheet", () => {
  const css = fs.readFileSync(new URL("../../apps/web/src/styles/layout.css", import.meta.url), "utf8");
  const layout = fs.readFileSync(new URL("../../apps/web/src/components/layout.js", import.meta.url), "utf8");
  assert.match(css, /\.ai\.full\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/s);
  assert.doesNotMatch(layout, /SNAPS|snapTo\(/);
  assert.match(layout, /setH\(clamp\(current, minOpenH\(\), max - 1\)\)/);
});
