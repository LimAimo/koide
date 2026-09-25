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
  assert.deepEqual(a.calls, [
    ["fs.read", { path: "src/a.js" }],
    ["git.status", {}],
    ["agent.stop", {}],
    ["workspace.remove_recent", { path: "/tmp/x" }],
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
