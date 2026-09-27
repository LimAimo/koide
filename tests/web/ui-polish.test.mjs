import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";

installFakeDom();
const { state, runtime } = await import("../../apps/web/src/services/app.js");
const { saveSettings } = await import("../../apps/web/src/services/store.js");
const { openSettings } = await import("../../apps/web/src/components/settings.js");
const { createFileTree } = await import("../../apps/web/src/components/file-tree.js");
const wait = () => new Promise((resolve) => setTimeout(resolve, 12));
const workspace = (name) => ({ id: name, name, roots: [`/tmp/${name}`] });

test("设置搜索保留结果层级、展示空状态，关闭后旧动画不复活", async () => {
  saveSettings({ anim: { reduced: "on" } });
  const first = openSettings();
  assert.equal(openSettings(), first, "重复入口复用当前设置页");
  const search = first.el.querySelector('input[type="search"]');
  search.value = "not-a-real-setting"; search.dispatchEvent({ type: "input" });
  assert.equal(first.el.querySelector(".settings-empty").hidden, false);
  assert.ok([...first.el.querySelectorAll(".settings-group")].every((group) => group.hidden));
  first.el.querySelector(".settings-empty button").click();
  assert.equal(search.value, "");
  assert.equal(first.el.querySelector(".settings-empty").hidden, true);
  first.close();
  assert.equal(first.el.inert, true);
  const next = openSettings();
  await wait();
  assert.equal(first.el.classList.contains("in"), false);
  assert.equal(next.el.classList.contains("in"), true);
  assert.equal(document.querySelectorAll(".page").length, 1);
  next.close(); await wait();
});

test("迟到的指令读取与服务商更新不覆盖输入中的草稿", async () => {
  const oldGet = runtime.instructions.get, oldDevices = runtime.devices.list;
  let finishRead;
  runtime.instructions.get = () => new Promise((resolve) => { finishRead = resolve; });
  runtime.devices.list = async () => ({ devices: [] });
  state.set({ conn: "online", workspace: null, hello: { version: "7.8.9-rc.4", tools: [], recent: [] } });
  const page = openSettings();
  try {
    const draft = page.el.querySelector('textarea[aria-label="全局指令"]');
    draft.value = "正在写的项目要求"; draft.dispatchEvent({ type: "input" });
    finishRead({ global: "磁盘旧文本", project: "", project_exists: false });
    await wait();
    state.set({ profiles: [{ id: "one", name: "新服务商", model: "model", has_key: true }] });
    assert.equal(page.el.querySelector('textarea[aria-label="全局指令"]'), draft);
    assert.equal(draft.value, "正在写的项目要求");
    assert.ok(page.el.textContent.includes("Koide 7.8.9-rc.4 Web"));
  } finally {
    page.close(); runtime.instructions.get = oldGet; runtime.devices.list = oldDevices;
    state.set({ conn: "offline", profiles: [], hello: null }); await wait();
  }
});

test("目录展开后立刻收起，迟到的子目录响应不能重新展开", async () => {
  const oldTree = runtime.files.tree;
  let finishChildren;
  runtime.files.tree = ({ path }) => path === "." ? Promise.resolve([{ path: "src", name: "src", type: "dir" }]) : new Promise((resolve) => { finishChildren = resolve; });
  state.set({ workspace: workspace("one") });
  const tree = createFileTree({ onOpen() {} }); document.body.appendChild(tree.el);
  try {
    await tree.reset();
    const node = tree.el.querySelector(".node"), row = node.querySelector(".row");
    row.click(); row.click();
    finishChildren([{ path: "src/a.js", name: "a.js", type: "file" }]);
    await wait();
    assert.equal(node.classList.contains("open"), false);
    assert.equal(row.getAttribute("aria-expanded"), "false");
  } finally { tree.el.remove(); runtime.files.tree = oldTree; }
});

test("切换项目拒绝旧文件树响应，读取失败提供重试而不冒充空目录", async () => {
  const oldTree = runtime.files.tree;
  let finishOld;
  runtime.files.tree = () => new Promise((resolve) => { finishOld = resolve; });
  state.set({ workspace: workspace("old") });
  const tree = createFileTree({ onOpen() {} }); document.body.appendChild(tree.el);
  try {
    const oldRead = tree.reset();
    state.set({ workspace: workspace("new") });
    runtime.files.tree = async () => [{ path: "new.js", name: "new.js", type: "file" }];
    await tree.reset();
    finishOld([{ path: "old.js", name: "old.js", type: "file" }]); await oldRead;
    assert.deepEqual([...tree.el.querySelectorAll(".name")].map((el) => el.textContent), ["new.js"]);
    runtime.files.tree = async () => { throw new Error("读取权限已撤销"); };
    await tree.reset();
    assert.match(tree.el.textContent, /读取权限已撤销/);
    assert.doesNotMatch(tree.el.textContent, /这个文件夹是空的/);
    runtime.files.tree = async () => [];
    tree.el.querySelector("button").click(); await wait();
    assert.equal(tree.el.querySelector('[role="alert"]').hidden, true);
    assert.match(tree.el.textContent, /这个文件夹是空的/);
  } finally { tree.el.remove(); runtime.files.tree = oldTree; state.set({ workspace: null }); }
});
