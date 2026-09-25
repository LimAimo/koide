import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, anims } from "./fake-dom.mjs";

installFakeDom();
const { CodeEditor } = await import("../../apps/web/src/editor/code-editor.js");
const { playDiffusion } = await import("../../apps/web/src/animations/diffusion/renderer.js");
const { analyze } = await import("../../apps/web/src/animations/diffusion/engine.js");
const { highlightLine } = await import("../../apps/web/src/editor/highlight.js");

const SRC = "def add(a, b):\n    return a - b\n\nprint(add(1, 2))\n";

test("highlighter classifies keywords, strings, numbers, comments, calls", () => {
  const segs = highlightLine('def f(x): return "hi" + 42  # note', "py");
  const cls = (s) => segs.filter((x) => x.cls === s).length;
  assert.ok(cls("tk-kw") >= 2 && cls("tk-str") === 1 && cls("tk-num") === 1 && cls("tk-com") === 1 && cls("tk-fn") === 1);
});

test("editor renders lines + gutter and updates only what changed", () => {
  const ed = new CodeEditor();
  ed.setDocument({ path: "a.py", text: SRC });
  assert.equal(ed.lineEls.length, 5);
  assert.equal(ed.gutter.textContent, "1\n2\n3\n4\n5");
  const untouched = ed.lineEls[3];
  ed.input.value = SRC.replace("a - b", "a * b");
  ed.input.dispatchEvent({ type: "input" });
  assert.equal(ed.getValue().includes("a * b"), true);
  assert.equal(ed.lineEls[3], untouched, "unchanged lines keep their DOM nodes");
  assert.equal(ed.lineEls[1].textContent, "    return a * b");
});

test("auto-indent on Enter after an opener", () => {
  const ed = new CodeEditor();
  ed.setDocument({ path: "a.py", text: "def f():" });
  ed.input.setSelectionRange(8, 8);
  let prevented = false;
  ed._onKey({ key: "Enter", preventDefault: () => (prevented = true), ctrlKey: false, metaKey: false, shiftKey: false });
  assert.ok(prevented);
  assert.equal(ed.input.value, "def f():\n  ");
});

test("AI edit plays Diffusion: overlay appears, animates, then cleans itself up", async () => {
  const ed = new CodeEditor();
  ed.setDocument({ path: "a.py", text: SRC });
  anims.length = 0;
  const after = SRC.replace("a - b", "a + b").replace("print(add(1, 2))", "total = add(1, 2)\nprint(total)");
  const seen = { playing: false };
  const p = ed.applyExternal(after, { animate: true });
  seen.playing = ed.el.classList.contains("dfx-playing");
  const { plan } = await p;
  assert.equal(seen.playing, true, "text layer is hidden while the overlay plays");
  assert.equal(plan.granularity, "token");
  assert.ok(anims.length > 0, "atoms were animated");
  assert.equal(ed.getValue(), after);
  assert.equal(ed.lineEls[1].textContent, "    return a + b");
  assert.equal(ed.el.classList.contains("dfx-playing"), false);
  assert.equal(ed.body.children.filter((c) => /dfx-layer|dfx-ghost/.test(c.className)).length, 0, "overlay + ghosts removed");
  const texts = anims.map((a) => a.el.textContent);
  assert.ok(texts.includes("-") && texts.includes("+"), "operator morph: old token dissolves, new token builds");
});

test("renderer measures with the grid and places text at real coordinates", async () => {
  const host = document.createElement("div");
  const before = "x = 1\nfoo()\n", after = "foo()\nx = 1\n";
  const plan = analyze(before, after);
  const run = playDiffusion(host, before, after, plan, { lang: "py" });
  const layer = host.children.find((c) => /dfx-layer/.test(c.className));
  const moved = layer.children.filter((c) => /dfx-move/.test(c.className));
  assert.ok(moved.length >= 1);
  const a = anims.find((x) => /dfx-move/.test(x.el.className));
  assert.match(a.keyframes[0].transform, /translate\(.*px,.*px\)/);
  assert.notEqual(a.keyframes[0].transform, a.keyframes[1].transform);
  await run.finished;
});

test("a second edit during playback cancels the first cleanly", async () => {
  const ed = new CodeEditor();
  ed.setDocument({ path: "a.py", text: SRC });
  const first = ed.applyExternal(SRC + "x = 1\n", { animate: true });
  const second = ed.applyExternal(SRC + "x = 1\ny = 2\n", { animate: true });
  await Promise.all([first, second]);
  assert.equal(ed.getValue(), SRC + "x = 1\ny = 2\n");
  assert.equal(ed.body.children.filter((c) => /dfx-layer|dfx-ghost/.test(c.className)).length, 0);
});

test("no animation flag: text swaps silently", async () => {
  const ed = new CodeEditor();
  ed.setDocument({ path: "a.py", text: SRC });
  anims.length = 0;
  const r = await ed.applyExternal("print('hi')\n", { animate: false });
  assert.equal(r.plan, null);
  assert.equal(anims.length, 0);
});
