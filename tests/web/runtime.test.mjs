import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../apps/web/src/services/runtime/index.js";

class FakeAdapter {
  constructor() { this.kind = "fake"; this.status = "online"; this.calls = []; this.handlers = new Map(); }
  call(method, params = {}) { this.calls.push([method, params]); return Promise.resolve({ method, params }); }
  on(event, fn) { this.handlers.set(event, fn); return () => this.handlers.delete(event); }
  onStatus(fn) { fn(this.status); return () => {}; }
  discover() { return Promise.resolve({ native: true }); }
  connect(t) { return Promise.resolve(t); }
  close() {}
  pair(target, code, name) { return Promise.resolve(`${target.host}:${code}:${name}`); }
}

test("Runtime API hides transport details behind domain methods", async () => {
  const a = new FakeAdapter();
  const runtime = createRuntime(a);
  await runtime.files.read({ path: "src/a.js" });
  await runtime.git.status();
  await runtime.agent.stop();
  await runtime.workspace.removeRecent({ path: "/tmp/x" });
  await runtime.feedback.emit({ kind: "snap" });
  assert.deepEqual(a.calls, [
    ["fs.read", { path: "src/a.js" }],
    ["git.status", {}],
    ["agent.stop", {}],
    ["workspace.remove_recent", { path: "/tmp/x" }],
    ["feedback.emit", { kind: "snap" }],
  ]);
  assert.equal(runtime.kind, "fake");
  assert.equal(runtime.status, "online");
});

test("Runtime forwards domain events without exposing Bridge", () => {
  const a = new FakeAdapter();
  const runtime = createRuntime(a);
  let value = null;
  const off = runtime.on("fs.changed", (d) => { value = d; });
  a.handlers.get("fs.changed")({ path: "x" });
  assert.deepEqual(value, { path: "x" });
  off();
  assert.equal(a.handlers.has("fs.changed"), false);
});

test("Remote pairing is an optional runtime capability", async () => {
  const runtime = createRuntime(new FakeAdapter());
  assert.equal(await runtime.remote.pair({ host: "10.0.0.2" }, "123456", "phone"), "10.0.0.2:123456:phone");
});

test("子任务事件仅进入工程视图，审批仍可到达主界面", () => {
  const adapter = new FakeAdapter(), handlers = new Map();
  adapter.on = (name, fn) => { const list = handlers.get(name) || []; list.push(fn); handlers.set(name,list); return () => {}; };
  const runtime = createRuntime(adapter), main = [], all = [], approvals = [];
  runtime.on("agent.started", (data) => main.push(data));
  runtime.on("fs.changed", (data) => main.push(data));
  runtime.onAll("agent.started", (data) => all.push(data));
  runtime.on("approval.request", (data) => approvals.push(data));
  const emit = (name, data) => (handlers.get(name) || []).forEach((fn) => fn(data));
  emit("agent.started", {task_id:"child",parent_task_id:"parent"});
  emit("fs.changed", {task_id:"child",path:"src/a.js"});
  emit("approval.request", {task_id:"child",id:"approval"});
  emit("agent.started", {task_id:"parent"});
  assert.deepEqual(main, [{task_id:"parent"}]);
  assert.equal(all.length, 2); assert.equal(approvals.length, 1);
});
