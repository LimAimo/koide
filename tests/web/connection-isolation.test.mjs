import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";
import { Bridge } from "../../apps/web/src/services/bridge.js";

installFakeDom();
globalThis.location = new URL("http://127.0.0.1:8765/");

class Socket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(raw) {
    if (this.readyState !== 1) throw new Error("socket closed");
    const msg = JSON.parse(raw); this.sent.push(msg);
    if (msg.method === "studio.read") queueMicrotask(() => this.respond(msg, this.studio || { data: {}, revision: "absent", workspace_key: "key" }));
  }
  respond(request, result) { this.onmessage?.({ data: JSON.stringify({ type: "result", id: request.id, result }) }); }
  close() { this.readyState = 3; }
  disconnect() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = Socket;
const target = (host) => ({ host, port: 8765 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check, timeout = 1500) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("等待连接测试事件超时"); await tick(); }
}
const hello = (name) => ({ workspace: { roots: ["/same-project"], name, capabilities: { git: false } },
  profiles: [{ id: name }], permissions: { mode: "manual" }, agent: { running: false, task_id: null }, approvals: [] });
async function finishConnecting(pending, payload, studio = {}) {
  const socket = Socket.instances.at(-1);
  socket.studio = { data: studio, revision: "absent", workspace_key: `${payload.workspace.name}-key` };
  socket.open(); socket.respond(socket.sent.find((msg) => msg.method === "hello"), payload);
  await pending; await tick(); return socket;
}

test("主动换连接立即拒绝旧 RPC，旧 socket 事件与闭包不能作用于新连接", async () => {
  const bridge = new Bridge(), seen = [];
  bridge.on("fs.changed", (value) => seen.push(value));
  const first = await finishConnecting(bridge.connect(target("first")), hello("first"));
  const read = bridge.rpc("fs.read", { path: "a.ts" });
  const rejected = assert.rejects(read, /连接已断开/);
  const oldMessage = first.onmessage, oldClose = first.onclose;
  const connecting = bridge.connect(target("second"));
  try {
    await rejected;
    assert.equal(first.onmessage, null); assert.equal(first.onopen, null); assert.equal(first.onclose, null);
    oldMessage({ data: JSON.stringify({ type: "event", event: "fs.changed", data: { path: "old.ts" } }) });
    const second = Socket.instances.at(-1); second.open();
    oldClose();
    assert.equal(bridge.ws, second);
    second.respond(second.sent.find((msg) => msg.method === "hello"), hello("second"));
    await connecting;
    assert.deepEqual(seen, []); assert.equal(bridge.hello.workspace.name, "second");
    assert.equal(bridge.status, "online"); assert.equal(bridge._pending.size, 0);
  } finally { bridge.close(); }
});

test("握手尚未完成时换连接会取消旧 connect，迟到的旧 hello 不能污染新 hello", async () => {
  const bridge = new Bridge(), seen = [];
  bridge.on("hello", (value) => seen.push(value.workspace.name));
  const original = bridge.connect(target("old")); const rejected = assert.rejects(original, /连接已取消/);
  const first = Socket.instances.at(-1); first.open(); const oldMessage = first.onmessage;
  const next = bridge.connect(target("new"));
  try {
    await rejected;
    const second = Socket.instances.at(-1); second.open();
    const request = second.sent.find((msg) => msg.method === "hello");
    oldMessage({ data: JSON.stringify({ type: "result", id: request.id, result: hello("old") }) });
    await tick(); assert.notEqual(bridge.status, "online");
    second.respond(request, hello("new")); await next;
    assert.deepEqual(seen, ["new"]); assert.equal(bridge.hello.workspace.name, "new");
  } finally { bridge.close(); }
});

const { connectManual, state, runtime, events, getWorkspaceEpoch } = await import("../../apps/web/src/services/app.js");
const { projectStore, studioState, addAttachment, getProjectEpoch } = await import("../../apps/web/src/services/studio.js");
const imageData = "data:image/png;base64,YWJj";

test("主动切换执行端即使项目路径相同，也清空旧项目与附件并重新加载新工作台", async () => {
  const first = await finishConnecting(connectManual(target("computer-a")), hello("A"), { brief: { goal: "电脑 A 的目标" } });
  state.set({ tabs: [{ path: "a.ts", text: "未保存的 A 内容", dirty: true }], active: "a.ts", conversationId: "a-conversation", approvals: [{ approval_id: "old" }] });
  addAttachment({ name: "A 的图片", data_url: imageData });
  const epoch = getWorkspaceEpoch(), projectEpoch = getProjectEpoch(), loaded = [];
  const off = events.on("conversation:load", (id) => loaded.push(id));
  const oldRead = runtime.files.read({ path: "a.ts" }), rejected = assert.rejects(oldRead, /连接已断开/);
  const oldMessage = first.onmessage;
  const switching = connectManual(target("computer-b"));
  try {
    assert.equal(state.get().workspace, null); assert.deepEqual(state.get().tabs, []);
    assert.equal(state.get().conversationId, null); assert.deepEqual(state.get().approvals, []); assert.deepEqual(state.get().profiles, []);
    assert.deepEqual(studioState.get().attachments, []); assert.deepEqual(loaded, [null]);
    oldMessage({ data: JSON.stringify({ type: "event", event: "agent.status", data: { task_id: "old", state: "editing" } }) });
    assert.equal(state.get().agent.running, false);
    await rejected;
    await finishConnecting(switching, hello("B"), { brief: { goal: "电脑 B 的目标" } });
    assert.equal(state.get().workspace.roots[0], "/same-project");
    assert.ok(getWorkspaceEpoch() > epoch); assert.ok(getProjectEpoch() > projectEpoch);
    assert.equal(projectStore.get().brief.goal, "电脑 B 的目标");
    assert.deepEqual(studioState.get().attachments, []);
  } finally { off(); runtime.close(); }
});

test("同一执行端自动重连保留项目、未保存文件、会话和附件，仍拒绝断线 RPC", async () => {
  const payload = hello("automatic");
  const first = await finishConnecting(connectManual(target("same-computer")), payload, { brief: { goal: "仍在创作" } });
  state.set({ tabs: [{ path: "a.ts", text: "未保存修改", dirty: true }], active: "a.ts", conversationId: "same-conversation" });
  addAttachment({ name: "保留的参考图", data_url: imageData });
  const epoch = getWorkspaceEpoch(), projectEpoch = getProjectEpoch(), count = Socket.instances.length;
  const read = runtime.files.read({ path: "a.ts" }), rejected = assert.rejects(read, /连接已断开/);
  first.disconnect();
  try {
    await rejected;
    assert.equal(state.get().conn, "offline"); assert.equal(state.get().tabs[0].dirty, true);
    await until(() => Socket.instances.length > count);
    const reconnecting = Socket.instances.at(-1);
    assert.equal(reconnecting.url, first.url);
    reconnecting.open(); reconnecting.respond(reconnecting.sent.find((msg) => msg.method === "hello"), payload);
    await until(() => state.get().conn === "online");
    assert.equal(getWorkspaceEpoch(), epoch); assert.equal(getProjectEpoch(), projectEpoch);
    assert.equal(state.get().tabs[0].text, "未保存修改"); assert.equal(state.get().conversationId, "same-conversation");
    assert.equal(studioState.get().attachments[0].name, "保留的参考图"); assert.equal(projectStore.get().brief.goal, "仍在创作");
  } finally { runtime.close(); }
});
