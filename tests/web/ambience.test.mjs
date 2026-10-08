import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, $$ } from "./fake-dom.mjs";
import { AMBIENCE_SCENES, normalizeAmbience, normalizeRoom, sanitizePreview, fitPostcardPreviews, POSTCARD_PREVIEW_LIMIT, POSTCARD_PREVIEW_BUDGET, startRoomSession, finishRoomSession,
  recordRoomActivity, addRoomMilestone, ambienceAgentState, createAmbienceAudio } from "../../apps/web/src/services/ambience.js";

test("创作房间只接受白名单配置，不传播未知字段和无效声音数值", () => {
  const config = normalizeAmbience({ scene: "javascript:alert(1)", intensity: "max", volume: 9, motion: false, sound: "true", mixes: { rain: -3, synth: "NaN", surprise: 9 }, url: "https://bad.test" });
  assert.equal(config.scene, "rain"); assert.equal(config.intensity, "daily"); assert.equal(config.volume, 1);
  assert.equal(config.sound, false); assert.equal(config.motion, false); assert.equal(config.mixes.rain, 0); assert.equal(config.mixes.synth, 0);
  assert.equal("url" in config, false); assert.equal("surprise" in config.mixes, false);
  assert.deepEqual(normalizeAmbience({ scene: "ocean" }).mixes, AMBIENCE_SCENES[1].mixes);
});

test("明信片图片只接受有界位图 data URI，不接受 SVG、远端追踪图片或脚本", () => {
  assert.equal(sanitizePreview("data:image/png;base64,YWJj"), "data:image/png;base64,YWJj");
  for (const value of ["data:image/svg+xml;base64,YWJj", "https://tracker.test/a.png", "javascript:alert(1)", "data:image/png;base64," + "a".repeat(POSTCARD_PREVIEW_LIMIT), "data:image/png;base64,<script>"]) assert.equal(sanitizePreview(value), "");
});

test("相册截图有总预算，优先保留新图，移除旧图时保留全部文字记录", () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, title: `创作 ${i}`, summary: `记录 ${i}`, preview: "data:image/png;base64," + "a".repeat(180000) }));
  const fitted = fitPostcardPreviews(cards);
  assert.equal(fitted.length, 30); assert.equal(fitted[0].preview, cards[0].preview); assert.equal(fitted[3].preview, "");
  assert.ok(fitted.reduce((size, c) => size + c.preview.length, 0) <= POSTCARD_PREVIEW_BUDGET); assert.equal(fitted[29].summary, "记录 29");
  const tiny = fitPostcardPreviews(cards.map((c) => ({ ...c, preview: "data:image/png;base64,YWJj" })));
  assert.equal(tiny.filter((c) => c.preview).length, 20);
});

test("截图恰好到达单张及总预算时保留，新增明信片优先于旧图", () => {
  const header = "data:image/png;base64,";
  const preview = (size) => header + "a".repeat(size - header.length);
  assert.equal(sanitizePreview(preview(POSTCARD_PREVIEW_LIMIT)).length, POSTCARD_PREVIEW_LIMIT);
  assert.equal(sanitizePreview(preview(POSTCARD_PREVIEW_LIMIT + 1)), "");
  const now = "2026-10-08T13:00:00Z";
  const images = [POSTCARD_PREVIEW_LIMIT, POSTCARD_PREVIEW_LIMIT, POSTCARD_PREVIEW_LIMIT, POSTCARD_PREVIEW_BUDGET - 3 * POSTCARD_PREVIEW_LIMIT];
  const cards = images.map((size, i) => ({ id: `old-${i}`, createdAt: now, title: `旧成果 ${i}`, summary: "这段文字始终保留", preview: preview(size) }));
  const atLimit = fitPostcardPreviews(cards); assert.equal(atLimit.reduce((sum, c) => sum + c.preview.length, 0), POSTCARD_PREVIEW_BUDGET);
  const data = { ...startRoomSession({ postcards: cards }, "最新成果"), postcards: cards };
  const result = finishRoomSession(data, { preview: preview(POSTCARD_PREVIEW_LIMIT), now, id: "newest" });
  assert.equal(result.postcards[0].id, "newest"); assert.equal(result.postcards[0].preview.length, POSTCARD_PREVIEW_LIMIT);
  assert.equal(result.postcards.length, 5); assert.ok(result.postcards.reduce((sum, c) => sum + c.preview.length, 0) <= POSTCARD_PREVIEW_BUDGET);
  assert.equal(result.postcards.at(-1).summary, "这段文字始终保留"); assert.equal(result.postcards.at(-1).preview, "");
});

test("开工、真实文件活动与收工形成可恢复的项目记录，重复事件不继续写 metadata", () => {
  assert.throws(() => startRoomSession({}, "  "), /写一句/);
  let room = { ...startRoomSession({}, "造一个记账页面", { now: "2026-10-08T12:00:00Z", id: "session-1" }) };
  assert.throws(() => startRoomSession(room, "第二次"), /还没有收工/);
  room = { ...room, ...recordRoomActivity(room, { path: "src/index.js", taskId: "task-1" }) };
  assert.equal(recordRoomActivity(room, { path: "src/index.js", taskId: "task-1" }), null);
  room = { ...room, ...recordRoomActivity(room, { path: "src/style.css" }) };
  const result = finishRoomSession(room, { summary: "记账列表已手动确认", next: "补上筛选", preview: "data:image/png;base64,YWJj", now: "2026-10-08T13:00:00Z", id: "card-1" });
  assert.equal(result.session.endedAt, "2026-10-08T13:00:00Z"); assert.equal(result.postcards[0].taskId, "task-1");
  assert.deepEqual(result.postcards[0].paths, ["src/index.js", "src/style.css"]); assert.equal(result.postcards[0].summary, "记账列表已手动确认");
  assert.equal(recordRoomActivity({ ...room, ...result }, { path: "late.js" }), null);
  assert.throws(() => finishRoomSession({ ...room, ...result }), /先开工/);
  const capped = { ...room, session: { ...room.session, paths: Array.from({ length: 100 }, (_, i) => `file-${i}`) } };
  assert.equal(recordRoomActivity(capped, { path: "one-more" }).session.paths.at(-1), "one-more");
});

test("瓶中世界由用户明确收藏，保留任务与明信片关系并限制历史大小", () => {
  assert.throws(() => addRoomMilestone({}, { title: "" }), /起个名字/);
  const result = addRoomMilestone({}, { title: "第一个可用首页", item: "bridge", taskId: "t1", postcardId: "p1", now: "2026-10-08T13:00:00Z", id: "m1" });
  assert.deepEqual(result.milestones[0], { id: "m1", title: "第一个可用首页", item: "bridge", taskId: "t1", postcardId: "p1", createdAt: "2026-10-08T13:00:00Z" });
  const items = Array.from({ length: 100 }, (_, i) => ({ ...result.milestones[0], id: `m${i}` }));
  assert.equal(normalizeRoom({ milestones: items }).milestones.length, 36);
  assert.equal(normalizeRoom({ milestones: [{ id: "bad", createdAt: "not-time" }] }).milestones.length, 0);
});

test("锦鲤和工作灯只跟随真实运行状态，审批优先，不把任务结束当成验证通过", () => {
  assert.equal(ambienceAgentState({ agent: { running: true, state: "editing" } }).id, "editing");
  assert.equal(ambienceAgentState({ approvals: [{}], agent: { running: true, state: "editing" } }).id, "waiting");
  assert.equal(ambienceAgentState({ agent: { running: false, state: "editing" } }).id, "idle");
  assert.equal(ambienceAgentState({ agent: { running: true, state: "waiting_user" } }).id, "waiting");
  assert.equal(ambienceAgentState({ agent: { running: false, state: "error" } }).id, "error");
});

class FakeParam {
  constructor(value = 0) { this.value = value; this.updates = []; }
  cancelScheduledValues() {}
  setTargetAtTime(value) { this.value = value; this.updates.push(value); }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
}
class FakeAudioNode {
  constructor() { this.gain = new FakeParam(); this.frequency = new FakeParam(); this.Q = new FakeParam(); this.stopped = false; }
  connect() {} disconnect() { this.disconnected = true; } start() { this.started = true; } stop() { this.stopped = true; }
}
class FakeAudioContext {
  static instances = [];
  constructor() { this.sampleRate = 80; this.currentTime = 1; this.state = "suspended"; this.nodes = []; this.destination = {}; FakeAudioContext.instances.push(this); }
  createGain() { const n = new FakeAudioNode(); this.nodes.push(n); return n; }
  createOscillator() { return this.createGain(); } createBufferSource() { return this.createGain(); } createBiquadFilter() { return this.createGain(); }
  createBuffer(channels, size) { const lists = Array.from({ length: channels }, () => new Float32Array(size)); return { getChannelData: (i) => lists[i] }; }
  async resume() { this.state = "running"; } async suspend() { this.state = "suspended"; } async close() { this.state = "closed"; }
}

test("声音必须由用户启动，后台暂停、前台续播，关闭开关后不会自动重开", async () => {
  FakeAudioContext.instances = [];
  const sound = createAmbienceAudio({ AudioContext: FakeAudioContext, random: () => .4 });
  sound.configure({ sound: true }); assert.equal(FakeAudioContext.instances.length, 0); assert.equal(sound.status.playing, false);
  await sound.start(); const ctx = FakeAudioContext.instances[0]; assert.equal(sound.status.playing, true);
  assert.equal(sound.foley("verified"), true); assert.equal(sound.foley("saved"), false, "密集事件被限流");
  sound.setHidden(true); assert.equal(ctx.state, "suspended"); assert.equal(sound.foley("saved"), false);
  sound.setHidden(false); assert.equal(ctx.state, "running"); ctx.currentTime += 1; assert.equal(sound.foley("saved"), true);
  sound.configure({ sound: false }); assert.equal(sound.status.playing, false);
  sound.setHidden(true); sound.setHidden(false); assert.equal(ctx.state, "suspended");
  await sound.dispose(); assert.equal(ctx.state, "closed"); assert.ok(ctx.nodes.filter((n) => n.started).every((n) => n.stopped));
  await assert.rejects(sound.start(), /已经关闭/);
});

test("音频能力缺失与关闭操作音开关有明确行为", async () => {
  const unsupported = createAmbienceAudio({ AudioContext: null }); assert.equal(unsupported.status.supported, false); await assert.rejects(unsupported.start(), /不支持/);
  const sound = createAmbienceAudio({ AudioContext: FakeAudioContext }); await sound.start(); sound.configure({ sound: true, foley: false }); assert.equal(sound.foley("saved"), false);
  sound.configure({ sound: true }); assert.equal(sound.foley("unknown"), false); await sound.dispose();
});

function store(initial) {
  let value = initial; const listeners = new Set();
  return { get: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async update(patch) { value = { ...value, ...patch }; listeners.forEach((fn) => fn(value)); }, set(patch) { value = { ...value, ...patch }; listeners.forEach((fn) => fn(value)); } };
}
function emitter() { const listeners = new Map(); return { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); }, emit(name, value) { listeners.get(name)?.forEach((fn) => fn(value)); } }; }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("真实组件的场景、开工、心流、锦鲤和验证事件可操作，HTML 文本保持惰性", async () => {
  const dom = installFakeDom();
  const { createAmbience } = await import("../../apps/web/src/components/ambience.js");
  const project = store({}), state = store({ workspace: { roots: ["project-a"] }, agent: { running: false, state: "idle" } }), events = emitter(), runtime = emitter();
  let focused = null, taskPanel = 0; const played = [];
  const audio = { configure() {}, setHidden() {}, async start() {}, foley(kind) { played.push(kind); }, get status() { return { supported: true, activated: false, playing: false }; }, async dispose() {} };
  const app = document.createElement("div"); document.body.append(app);
  const ui = createAmbience({ app, projectStore: project, state, events, runtime, audio, audioFactory: () => audio, onFocus: (v) => { focused = v; }, onTaskPanel: () => { taskPanel++; } }); app.append(ui.el, ui.button);
  ui.button.click();
  assert.match(document.body.textContent, /创作房间/); assert.equal($$(document.body, ".ambience-scene-choice").length, 4);
  $$(document.body, '.ambience-scene-choice[data-scene="ocean"]')[0].click(); await tick();
  assert.equal(project.get().ambience.scene, "ocean"); assert.equal(app.dataset.ambienceScene, "ocean");
  const focus = $$(document.body, 'input[aria-label="心流布局"]')[0]; focus.checked = true; focus.dispatchEvent({ type: "change" }); await tick();
  assert.equal(focused, true); assert.equal(app.classList.contains("ambience-focus"), true);
  const goal = $$(document.body, 'input[aria-label="这次想做出什么"]')[0]; goal.value = '<img src=x onerror=alert(1)> 做首页';
  $$(document.body, ".ambience-actions button").find((node) => node.textContent.includes("开工")).click(); await tick();
  assert.equal(project.get().session.goal, '<img src=x onerror=alert(1)> 做首页'); assert.equal($$(document.body, "img").length, 0);
  runtime.emit("fs.changed", { actor: "agent", path: "src/app.js" }); runtime.emit("agent.started", { task_id: "t1" }); await tick(); await tick();
  assert.deepEqual(project.get().session.paths, ["src/app.js"]); assert.deepEqual(project.get().session.tasks, ["t1"]);
  runtime.emit("fs.changed", { actor: "user", path: ".diffusion/studio.json" }); await tick(); assert.deepEqual(project.get().session.paths, ["src/app.js"]);
  state.set({ agent: { running: true, state: "editing" } }); assert.equal(ui.el.dataset.state, "editing");
  const { settingsStore } = await import("../../apps/web/src/services/store.js");
  settingsStore.set({ anim: { ...settingsStore.get().anim, reduced: "on" } }); assert.equal(app.dataset.ambienceMotion, "false");
  settingsStore.set({ anim: { ...settingsStore.get().anim, reduced: "system" } }); assert.equal(app.dataset.ambienceMotion, "true");
  events.emit("studio:verified", { passed: false }); assert.notEqual(ui.el.dataset.verified, "true");
  events.emit("studio:verified", { passed: true }); assert.equal(ui.el.dataset.verified, "true");
  $$(app, ".ambience-pet")[0].click(); assert.equal(taskPanel, 1);
  dom.doc.hidden = true; dom.fireDoc("visibilitychange"); assert.equal(app.dataset.ambienceMotion, "false");
  await ui.dispose(); assert.equal(app.classList.contains("ambience-focus"), false);
});

test("项目切换会丢弃延迟中的混音写入，不能把前一个项目的偏好写到后一个项目", async () => {
  installFakeDom(); const { createAmbience } = await import("../../apps/web/src/components/ambience.js");
  const project = store({}), state = store({ workspace: { roots: ["a"] }, agent: {} });
  const audio = { configure() {}, setHidden() {}, foley() {}, async dispose() {}, get status() { return { supported: true }; } };
  const ui = createAmbience({ projectStore: project, state, audio, audioFactory: () => audio }); document.body.append(ui.el); ui.open();
  const volume = $$(document.body, 'input[aria-label="总音量"]')[0]; volume.value = "99"; volume.dispatchEvent({ type: "input" });
  state.set({ workspace: { roots: ["b"] } }); await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(project.get().ambience, undefined); await ui.dispose();
});

test("收工真实保存截图与用户说明，明信片能收藏为关联里程碑", async () => {
  installFakeDom(); const { createAmbience } = await import("../../apps/web/src/components/ambience.js");
  const project = store({ ...startRoomSession({}, "可运行的首页"), session: { ...startRoomSession({}, "可运行的首页").session, tasks: ["task-2"], paths: ["index.html"] } });
  const state = store({ workspace: { roots: ["a"] }, agent: {} }), audio = { configure() {}, setHidden() {}, foley() {}, async dispose() {}, get status() { return { supported: true }; } };
  const ui = createAmbience({ projectStore: project, state, audio, audioFactory: () => audio, getPreview: () => "data:image/png;base64,YWJj" }); ui.open();
  $$(document.body, ".ambience-actions button").find((el) => el.textContent.includes("收工")).click();
  $$(document.body, 'textarea[aria-label="这次做出了什么"]')[0].value = "首页已在手机宽度下确认";
  $$(document.body, 'input[aria-label="下次从哪里继续"]')[0].value = "加上登录";
  $$(document.body, ".dialog-actions button").find((el) => el.textContent === "收工").click(); await tick(); await tick();
  assert.equal(project.get().postcards[0].summary, "首页已在手机宽度下确认"); assert.equal(project.get().postcards[0].next, "加上登录");
  assert.equal(project.get().postcards[0].preview, "data:image/png;base64,YWJj"); assert.equal(project.get().postcards[0].taskId, "task-2");
  $$(document.body, ".ambience-postcard")[0].click();
  $$(document.body, ".sheet-footer button").find((el) => el.textContent === "收藏为里程碑").click();
  $$(document.body, '.dialog-actions button').find((el) => el.textContent === "放进瓶中").click(); await tick(); await tick();
  assert.equal(project.get().milestones[0].postcardId, project.get().postcards[0].id); assert.equal(project.get().milestones[0].taskId, "task-2");
  await ui.dispose();
});

test("项目关闭后旧里程碑弹窗不能污染另一个项目", async () => {
  installFakeDom(); const { createAmbience } = await import("../../apps/web/src/components/ambience.js");
  const project = store({}), state = store({ workspace: { roots: ["a"] }, agent: {} });
  const audio = { configure() {}, setHidden() {}, foley() {}, async dispose() {}, get status() { return { supported: true }; } };
  const ui = createAmbience({ projectStore: project, state, audio, audioFactory: () => audio }); ui.open();
  $$(document.body, ".ambience-actions button").find((el) => el.textContent.includes("放入")).click();
  $$(document.body, 'input[aria-label="里程碑名称"]')[0].value = "属于 A 的成果";
  state.set({ workspace: { roots: ["b"] } });
  $$(document.body, ".dialog-actions button").find((el) => el.textContent === "放进瓶中").click(); await tick();
  assert.equal(project.get().milestones, undefined); await ui.dispose();
});
