import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";
import { lineDiff, validationStories } from "../../apps/web/src/services/history-diff.js";

const env = installFakeDom();
const { h } = await import("../../apps/web/src/components/dom.js");
const { settingsStore, saveSettings, applyTheme } = await import("../../apps/web/src/services/store.js");
const { velocityTracker, springTo, sheetDestination } = await import("../../apps/web/src/services/motion.js");
const { openSheet, openDialog, hasLayers, closeTopLayer } = await import("../../apps/web/src/components/overlays.js");
const { setupLayout } = await import("../../apps/web/src/components/layout.js");
const { createHistoryDiff } = await import("../../apps/web/src/components/history-diff.js");
const wait = () => new Promise((resolve) => setTimeout(resolve, 12));

test("行差异：真实增删、行号、空文件、重复行和末尾换行", () => {
  const diff = lineDiff("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");
  assert.deepEqual([diff.added, diff.deleted], [2, 1]);
  const changes = diff.hunks.flatMap((h) => h.rows).filter((r) => r.kind !== "equal");
  assert.deepEqual(changes.map((r) => [r.kind, r.oldLine, r.newLine]), [["delete", 2, null], ["insert", null, 2], ["insert", null, 4]]);
  assert.equal(lineDiff(null, "").added, 0);
  assert.equal(lineDiff(null, "\n").added, 1);
  assert.equal(lineDiff("x\nx\n", "x\n").deleted, 1);
  const eof = lineDiff("x\n", "x");
  assert.deepEqual([eof.added, eof.deleted], [1, 1]);
  assert.equal(eof.hunks[0].rows.at(-1).noNewline, true);
});

test("巨大行差异明确降级，代码以文本渲染", () => {
  assert.equal(lineDiff("a\n".repeat(2000), "b\n".repeat(2000)).limited, true);
  const view = createHistoryDiff({ before: "", after: '<img src=x onerror="bad()">\n' });
  assert.equal(view.querySelector("img"), null);
  assert.match(view.textContent, /<img/);
  assert.match(createHistoryDiff({ text_available: false }).textContent, /无法显示行差异/);
});

test("验证故事线：其他命令不能消除失败，无修改重跑不能冒充修复", () => {
  const failure = { seq: 1, type: "build_failed", arguments: { command: "pnpm test" } };
  const pass = { seq: 3, type: "build_ok", arguments: { command: "pnpm test" } };
  const edit = { seq: 2, type: "edit" };
  assert.equal(validationStories([failure, { ...pass, arguments: { command: "pwd" } }])[0].state, "open");
  assert.equal(validationStories([failure, { ...pass, arguments: { command: "pnpm test", cwd: "other" } }])[0].state, "open");
  assert.equal(validationStories([failure, pass])[0].state, "retried");
  assert.equal(validationStories([failure, edit, pass])[0].state, "fixed");
  assert.equal(validationStories([failure, edit, pass, { ...edit, seq: 4 }])[0].state, "stale");
  assert.equal(validationStories([failure, { ...edit, reverted: true }, pass])[0].state, "stale");
  assert.equal(validationStories([{ ...failure, arguments: null }, pass])[0].state, "open");
});

test("松手意图：速度过期、半屏吸附、自由高度、全屏向下回半屏", () => {
  const velocity = velocityTracker(0, 0); velocity.add(40, 40);
  assert.equal(velocity.value(45), 1);
  assert.equal(velocity.value(200), 0);
  assert.equal(sheetDestination(410, 0, 800), 400);
  assert.equal(sheetDestination(570, 0, 800), 570);
  assert.equal(sheetDestination(450, 0.8, 800), 800);
  assert.equal(sheetDestination(680, -1, 800, true), 400);
  assert.equal(sheetDestination(260, -1, 800), 0);
});

test("弹簧可取消且减少动态效果立即落位", () => {
  const originalRAF = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  let callback, value = 200, completed = false;
  globalThis.requestAnimationFrame = (fn) => { callback = fn; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const stop = springTo({ from: 200, to: 400, update: (v) => { value = v; }, complete: () => { completed = true; } });
    callback(performance.now() + 20); assert.ok(value > 200 && value < 400);
    const stoppedAt = value; stop(); callback(performance.now() + 1000);
    assert.equal(value, stoppedAt); assert.equal(completed, false);
    saveSettings({ anim: { reduced: "on" } }); applyTheme();
    springTo({ from: 200, to: 400, update: (v) => { value = v; } });
    assert.equal(value, 400); assert.equal(document.documentElement.dataset.reducedMotion, "true");
  } finally { globalThis.requestAnimationFrame = originalRAF; globalThis.cancelAnimationFrame = originalCancel; }
});

test("浮层立即关闭、连点关闭再打开、嵌套关闭不会误退新浮层", async () => {
  let count = 0;
  const first = openSheet({ title: "旧", onClose: () => count++ });
  first.close(); first.close();
  const next = openSheet({ title: "新" });
  await wait();
  assert.equal(count, 1); assert.equal(next.el.classList.contains("in"), true);
  assert.equal(first.el.classList.contains("in"), false); assert.equal(hasLayers(), true);
  const top = openDialog({ title: "上层" });
  next.close(); top.close(); await wait();
  assert.equal(hasLayers(), false);
});

test("Sheet pointercancel 不触发关闭，多指不会抢走手势", async () => {
  const sheet = openSheet({ title: "保留" }); await wait();
  const grip = sheet.el.querySelector(".sheet-handle");
  grip.dispatchEvent({ type: "pointerdown", pointerId: 1, clientY: 100 });
  grip.dispatchEvent({ type: "pointermove", pointerId: 2, clientY: 600 });
  assert.equal(sheet.el.style.transform, "translateY(0px)");
  grip.dispatchEvent({ type: "pointermove", pointerId: 1, clientY: 450 });
  grip.dispatchEvent({ type: "pointercancel", pointerId: 1 });
  assert.equal(sheet.el.classList.contains("in"), true);
  assert.equal(sheet.el.style.transform, ""); sheet.close(); await wait();
});

test("AI 面板取消拖拽恢复原位，关闭全屏后重新打开半屏", async () => {
  const app = h("div"), ai = h("div"), grip = h("div"), files = h("div"), scrim = h("div");
  const layout = setupLayout({ app, ai, grip, files, scrim, resizers: { r1: h("div"), r2: h("div") }, onCloseAI: () => app.classList.add("ai-hidden") });
  Object.defineProperty(ai, "offsetHeight", { get: () => Number.parseFloat(app.style.getPropertyValue("--sheet-h")) || 400 });
  layout.openSheetHalf();
  grip.dispatchEvent({ type: "pointerdown", pointerId: 1, clientY: 400 });
  grip.dispatchEvent({ type: "pointermove", pointerId: 1, clientY: 100 });
  assert.equal(app.style.getPropertyValue("--sheet-h"), "700px");
  grip.dispatchEvent({ type: "pointercancel", pointerId: 1 });
  assert.equal(app.style.getPropertyValue("--sheet-h"), "400px");
  grip.dispatchEvent({ type: "keydown", key: "Home", preventDefault() {} });
  assert.equal(ai.classList.contains("full"), true);
  layout.closeSheet(); layout.openSheetHalf();
  assert.equal(ai.classList.contains("full"), false); assert.equal(app.style.getPropertyValue("--sheet-h"), "400px");
  await wait(); assert.equal(hasLayers(), false);
});

test("对话框异步操作只执行一次", async () => {
  let count = 0, finish;
  const dialog = openDialog({ title: "确认", actions: [{ label: "执行", onClick: () => { count++; return new Promise((r) => { finish = r; }); } }] });
  const button = dialog.el.querySelector("button"); button.click(); button.click();
  assert.equal(count, 1); finish(); await wait(); assert.equal(hasLayers(), false);
});

test("工作现场保留活动与阶段节点，状态更新不重建列表", async () => {
  const { state } = await import("../../apps/web/src/services/app.js");
  const { openLiveWorkspace } = await import("../../apps/web/src/components/live-workspace.js");
  const live = { goal: "验证", stages: [{ id: "edit", label: "修改", state: "active" }], activities: [{ callId: "c1", tool: "fs_write", state: "running", path: "a.js" }] };
  state.set({ agent: { running: true, state: "editing" }, live });
  const sheet = openLiveWorkspace();
  const activity = sheet.el.querySelector(".live-activity"), stage = sheet.el.querySelector(".live-stage");
  state.set({ live: { ...live, stages: [{ ...live.stages[0], state: "done" }], activities: [{ ...live.activities[0], state: "done" }] } });
  assert.equal(sheet.el.querySelector(".live-activity"), activity);
  assert.equal(sheet.el.querySelector(".live-stage"), stage);
  assert.equal(activity.classList.contains("done"), true);
  sheet.close(); await wait(); assert.equal(hasLayers(), false);
  settingsStore.set({ anim: { ...settingsStore.get().anim, reduced: "system" } });
});
