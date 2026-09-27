import test from "node:test";
import assert from "node:assert/strict";
import { createFeedback } from "../../apps/web/src/services/feedback.js";

function setup(kind = "native") {
  let time = 0, visible = true, settings = { haptics: true, sound: false };
  const calls = [], sounds = [];
  const transport = { kind, feedback: { emit: async (params) => { calls.push(params); return { performed: true, reason: "performed" }; } } };
  const feedback = createFeedback({ transport, now: () => time, visible: () => visible,
    preferences: () => settings, playSound: (kind) => { sounds.push(kind); return true; } });
  feedback.setCapabilities({ haptics: true });
  return { feedback, calls, sounds, transport, tick: () => time += 200,
    hide: (hidden) => visible = !hidden, preferences: (value) => settings = value };
}

test("触觉受 capability 和用户开关控制，Bridge 不振动远端设备", async () => {
  const native = setup();
  assert.equal((await native.feedback.emit("snap")).performed, true);
  assert.deepEqual(native.sounds, []);
  native.tick(); native.preferences({ haptics: false, sound: false });
  assert.equal((await native.feedback.emit("confirm")).reason, "disabled");
  assert.equal(native.calls.length, 1);
  const bridge = setup("bridge");
  assert.equal((await bridge.feedback.emit("snap")).performed, false);
  assert.equal(bridge.calls.length, 0);
});

test("完成反馈不重复、不在后台补播，连续操作有频率限制", async () => {
  const f = setup();
  await f.feedback.emit("complete", { key: "task-1" });
  f.tick();
  assert.equal((await f.feedback.emit("complete", { key: "task-1" })).reason, "duplicate");
  await f.feedback.emit("restore");
  assert.equal((await f.feedback.emit("snap")).reason, "throttled");
  f.tick(); f.hide(true);
  assert.equal((await f.feedback.emit("complete", { key: "task-2" })).reason, "background");
  f.hide(false);
  assert.equal((await f.feedback.emit("complete", { key: "task-2" })).reason, "duplicate");
  assert.equal(f.calls.length, 2);
});

test("提示音需显式开启且仅完成/恢复发声，原生故障不阻断操作", async () => {
  const f = setup();
  f.preferences({ haptics: true, sound: true });
  await f.feedback.emit("confirm"); f.tick();
  assert.deepEqual(f.sounds, []);
  f.transport.feedback.emit = async () => { throw new Error("设备未提供触觉"); };
  const result = await f.feedback.emit("complete", { key: "task" });
  assert.equal(result.performed, false); assert.equal(result.sound, true);
  assert.deepEqual(f.sounds, ["complete"]);
  assert.equal((await f.feedback.emit("any-pattern")).reason, "unknown_kind");
});
