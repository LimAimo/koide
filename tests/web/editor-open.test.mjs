import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";
installFakeDom();
const { runtime, state, openFile, keepTab, updateText } = await import("../../apps/web/src/services/app.js");
const { studioState } = await import("../../apps/web/src/services/studio.js");
studioState.set({ workspaceKey: "临时测试" });
const disk = (path) => ({ path, content: "磁盘内容", revision: "r1" });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("再次明确打开已有预览文件会保留标签，不重读磁盘或阻止关闭", async () => {
  state.set({ tabs: [], active: null });
  let reads = 0;
  runtime.files.read = async ({ path }) => { reads++; return disk(path); };
  await openFile("a.ts", { preview: true });
  await openFile("a.ts", { preview: false });
  assert.equal(reads, 1); assert.equal(state.get().tabs[0].preview, false); assert.equal(state.get().tabs[0].pinned, false);
  await openFile("b.ts", { preview: true }); keepTab("b.ts");
  await openFile("c.ts", { preview: true });
  assert.deepEqual(state.get().tabs.map((tab) => tab.path), ["a.ts", "b.ts", "c.ts"]);
});

test("并发预览与普通打开合并唯一标签，迟到读取保留已输入的内容", async () => {
  state.set({ tabs: [], active: null });
  const pending = [];
  runtime.files.read = () => new Promise((resolve) => pending.push(resolve));
  const preview = openFile("a.ts", { preview: true }), permanent = openFile("a.ts", { preview: false });
  await flush(); assert.equal(pending.length, 2);
  pending[1](disk("a.ts")); await permanent;
  updateText("a.ts", "尚未保存的编辑");
  pending[0](disk("a.ts")); await preview;
  assert.equal(state.get().tabs.length, 1);
  assert.equal(state.get().tabs[0].text, "尚未保存的编辑");
  assert.equal(state.get().tabs[0].dirty, true); assert.equal(state.get().tabs[0].preview, false);
});

test("预览读取先返回时，迟到的普通打开将它升级为可保留的标签", async () => {
  state.set({ tabs: [], active: null });
  const pending = [];
  runtime.files.read = () => new Promise((resolve) => pending.push(resolve));
  const preview = openFile("a.ts", { preview: true }), permanent = openFile("a.ts", { preview: false });
  await flush(); pending[0](disk("a.ts")); await preview;
  assert.equal(state.get().tabs[0].preview, true);
  pending[1](disk("a.ts")); await permanent;
  assert.equal(state.get().tabs.length, 1); assert.equal(state.get().tabs[0].preview, false);
});
