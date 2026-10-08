import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, $$ } from "./fake-dom.mjs";
import { evidenceStatus, manualStatus, fitEvidence, imageBytes } from "../../apps/web/src/services/studio-model.js";

installFakeDom();
let emitNative, invoke;
globalThis.__TAURI__ = { core: { invoke: (...args) => invoke(...args) }, event: { listen: async (_, fn) => { emitNative = (event, data) => fn({ payload: { event, data } }); return () => {}; } } };
const { state, events, startAgent, openFile, saveTab, refreshTabFromDisk } = await import("../../apps/web/src/services/app.js");
const { projectStore, studioState, runVerification, buildContext, addAttachment } = await import("../../apps/web/src/services/studio.js");
const { createContextInput } = await import("../../apps/web/src/components/context-input.js");
const { createAmbience } = await import("../../apps/web/src/components/ambience.js");
const { startRoomSession } = await import("../../apps/web/src/services/ambience.js");
const { createCapsule } = await import("../../apps/web/src/components/status-capsule.js");
const { createWelcome } = await import("../../apps/web/src/components/welcome.js");
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw new Error("等待工作台事件超时"); }
let data, revision, writes;
async function fixture(name) {
  data = {}; revision = "absent"; writes = [];
  invoke = async (_, { method, params }) => {
    if (method === "studio.read") return { data, revision, workspace_key: `${name}-key` };
    if (method === "studio.write") { assert.equal(params.workspace_key, `${name}-key`); assert.equal(params.base_revision, revision); data = params.data; revision = `${writes.length + 1}`; writes.push(structuredClone(params)); return { data, revision, workspace_key: `${name}-key` }; }
    if (method === "studio.revision") return { revision: "code-1" };
    if (method === "git.status") return { is_repo: false, files: [] };
    throw new Error(`意外调用：${method}`);
  };
  state.set({ workspace: { name, roots: [`/${name}`], location: { kind: "local", path: `/${name}` }, capabilities: { git: false } }, tabs: [], active: null, conversationId: null });
  await until(() => !studioState.get().loading);
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const imageData = "data:image/png;base64,YWJj";
const fakeAudio = (start = async () => {}) => ({ configure() {}, setHidden() {}, foley() {}, start, async dispose() {}, get status() { return { supported: true, playing: false }; } });

test("工作台并发保存依序使用真实 revision，保留两个操作的内容", async () => {
  await fixture("queue");
  await Promise.all([projectStore.update({ context: ["a.ts"] }), projectStore.update((p) => ({ ...p, memories: [{ text: "决定" }], context: [...p.context, "b.ts"] }))]);
  assert.deepEqual(data.context, ["a.ts", "b.ts"]);
  assert.equal(writes[0].base_revision, "absent"); assert.equal(writes[1].base_revision, "1");
});

test("失败读取不会用空对象覆盖损坏的项目记录", async () => {
  invoke = async () => { throw new Error("工作台 JSON 已损坏"); };
  state.set({ workspace: { roots: ["/broken"], capabilities: { git: false } } });
  await until(() => !studioState.get().loading);
  await assert.rejects(projectStore.update({ context: [] }), /尚未成功读取/);
});

test("命令在启动 RPC 返回前输出并退出也能保存完整真实证据", async () => {
  await fixture("fast"); const base = invoke;
  invoke = async (...args) => {
    const { method, params } = args[1];
    if (method === "terminal.run") {
      assert.equal(params.cwd, "src");
      emitNative("terminal.output", { source: "user", id: "fast", data: "构建完成\n" });
      emitNative("terminal.exit", { source: "user", id: "fast", exit_code: 0, timed_out: false, cancelled: false });
      return { id: "fast" };
    }
    return base(...args);
  };
  await runVerification("check", "criterion", { cwd: "src" });
  assert.equal(data.evidence.length, 1); assert.equal(data.evidence[0].output, "构建完成\n");
  assert.equal(data.evidence[0].cwd, "src"); assert.equal(evidenceStatus(data.evidence[0], "code-1"), "passed");
  assert.deepEqual(studioState.get().commands, []);
});

test("超时、取消和代码变化均不算有效通过，人工验收也绑定代码版本", () => {
  const evidence = { revision: "r1", exit_code: 0 };
  assert.equal(evidenceStatus(evidence, "r2"), "stale");
  assert.equal(evidenceStatus({ ...evidence, cancelled: true }, "r1"), "failed");
  assert.equal(evidenceStatus({ ...evidence, timed_out: true }, "r1"), "failed");
  assert.equal(manualStatus({ manual_accepted: true, accepted_revision: "r1" }, "r1"), "accepted");
  assert.equal(manualStatus({ manual_accepted: true, accepted_revision: "r1" }, "r2"), "stale");
});

test("旧命令的大日志受总字节预算约束而保留状态记录", () => {
  const fitted = fitEvidence(Array.from({ length: 100 }, (_, i) => ({ id: i, output: "中文日志".repeat(15000), exit_code: 0, revision: "r1" })));
  assert.equal(fitted.length, 80); assert.equal(fitted.at(-1).id, 99);
  assert.ok(fitted.reduce((n, x) => n + new TextEncoder().encode(x.output).length, 0) <= 450 * 1024);
  assert.ok(fitted.every((x) => x.exit_code === 0 && x.output_truncated));
});

test("上下文发送时重新读取文件，带有效记忆、风格、选区并强制只读需求分析", async () => {
  await fixture("context");
  await projectStore.update({ context: ["a.ts"], memories: [{ text: "有效决策", source: "用户" }, { text: "旧决定", stale: true }], style: { colors: "蓝色" } });
  studioState.set({ selections: [{ path: "a.ts", text: "选中资料" }] });
  let captured; const base = invoke;
  invoke = async (...args) => {
    const { method, params } = args[1];
    if (method === "fs.read") return { content: "最新文件内容", revision: "fresh" };
    if (method === "agent.start") { captured = params; return { task_id: "draft" }; }
    return base(...args);
  };
  const context = await buildContext("需求");
  assert.match(context.goal, /最新文件内容/); assert.match(context.goal, /有效决策/); assert.doesNotMatch(context.goal, /旧决定/);
  assert.match(context.goal, /蓝色/); assert.match(context.goal, /选中资料/); assert.equal(context.included[0].revision, "fresh");
  state.set({ profiles: [{ id: "vision" }], conversationId: "old" });
  await startAgent("分析", { mode: "read", freshConversation: true });
  assert.equal(captured.mode, "read"); assert.equal(captured.conversation_id, null);
});

test("图片附件按解码后字节限制，拒绝 SVG、远端 URL 和错误 base64", () => {
  assert.equal(imageBytes({ data_url: "data:image/png;base64,YWJj" }), 3);
  for (const data_url of ["https://example.test/a.png", "data:image/svg+xml;base64,YWJj", "data:image/png;base64,YWJ"]) assert.throws(() => addAttachment({ data_url }), /只接受/);
});

test("旧 Agent 启动返回不能清空新项目附件或替换新项目会话", async () => {
  await fixture("agent-a"); state.set({ profiles: [{ id: "test" }], conversationId: "a-conversation" });
  const response = deferred(); let captured;
  const base = invoke;
  invoke = async (...args) => { if (args[1].method === "agent.start") { captured = args[1].params; return response.promise; } return base(...args); };
  const starting = startAgent("属于 A 的任务");
  const rejected = assert.rejects(starting, /项目已切换/);
  await until(() => !!captured);
  assert.equal(captured.workspace_key, "agent-a-key");
  await fixture("agent-b"); state.set({ conversationId: "b-conversation" }); addAttachment({ name: "属于 B", data_url: imageData });
  response.resolve({ conversation_id: "a-result" }); await rejected;
  assert.equal(state.get().conversationId, "b-conversation");
  assert.equal(studioState.get().attachments[0].name, "属于 B");
});

test("Agent 开始构建上下文前的异步模块加载也必须绑定原项目", async () => {
  await fixture("import-a"); state.set({ profiles: [{ id: "test" }] });
  const starting = startAgent("属于 A 的实现请求");
  const outcome = starting.then(() => null, (error) => error);
  const switching = fixture("import-b"); const base = invoke; let sent;
  invoke = async (...args) => { if (args[1].method === "agent.start") { sent = args[1].params; return { started: true }; } return base(...args); };
  await switching;
  const error = await outcome;
  assert.equal(sent, undefined, "旧项目目标不能使用新项目的上下文和工作区key启动");
  assert.match(error?.message || "", /项目已切换/);
});

test("图片 FileReader 的迟到结果不能加入后打开的项目", async () => {
  await fixture("image-a"); const previous = globalThis.FileReader, readers = [];
  globalThis.FileReader = class { readAsDataURL() { readers.push(this); } };
  const ui = createContextInput();
  try {
    const input = ui.tools.querySelector('input[type="file"]'); input.files = [{ name: "属于 A.png", size: 3 }];
    input.dispatchEvent({ type: "change" }); await until(() => readers.length === 1);
    await fixture("image-b"); readers[0].result = imageData; readers[0].onload(); await tick(); await tick();
    assert.deepEqual(studioState.get().attachments, []);
  } finally { globalThis.FileReader = previous; }
});

function mockCanvas() {
  const original = document.createElement;
  document.createElement = (tag) => { const el = original(tag); if (tag === "canvas") { el.getContext = () => ({ drawImage() {} }); el.toDataURL = () => imageData; } return el; };
  return () => { document.createElement = original; };
}
test("Image.decode 的迟到结果不能在新项目打开旧图标注", async () => {
  await fixture("decode-a"); const previous = globalThis.Image, decoding = deferred(); let decodingStarted = false;
  globalThis.Image = class { width = 100; height = 100; decode() { decodingStarted = true; return decoding.promise; } };
  const restoreCanvas = mockCanvas(), ui = createContextInput(); addAttachment({ name: "属于 A", data_url: imageData });
  const before = $$(document.body, ".studio-annotation-stage").length;
  try {
    $$(ui.tray, "button").find((el) => el.textContent === "圈选").click(); await until(() => decodingStarted);
    await fixture("decode-b"); decoding.resolve(); await tick(); await tick();
    assert.equal($$(document.body, ".studio-annotation-stage").length, before);
    assert.deepEqual(studioState.get().attachments, []);
  } finally { globalThis.Image = previous; restoreCanvas(); }
});

test("已经打开的旧项目标注确认按钮不能向新项目附图", async () => {
  await fixture("annotate-a"); const previous = globalThis.Image;
  globalThis.Image = class { width = 100; height = 100; async decode() {} };
  const restoreCanvas = mockCanvas(), ui = createContextInput(); addAttachment({ name: "属于 A", data_url: imageData });
  try {
    $$(ui.tray, "button").find((el) => el.textContent === "圈选").click();
    await until(() => $$(document.body, ".sheet-footer button").some((el) => el.textContent === "附加标注图"));
    const confirm = $$(document.body, ".sheet-footer button").filter((el) => el.textContent === "附加标注图").at(-1);
    await fixture("annotate-b"); confirm.click(); await tick();
    assert.deepEqual(studioState.get().attachments, []);
  } finally { globalThis.Image = previous; restoreCanvas(); }
});

test("收工截图等待期间 A 到 B 再回 A 不得保存到新的创作会话", async () => {
  await fixture("postcard-a"); await projectStore.update(startRoomSession(projectStore.get(), "原来的会话"));
  const screenshot = deferred(); let capturing = false; const audio = fakeAudio();
  const ui = createAmbience({ projectStore, state, audio, audioFactory: fakeAudio, getPreview: () => { capturing = true; return screenshot.promise; } });
  try {
    ui.open(); $$(document.body, ".ambience-actions button").filter((el) => el.textContent.includes("收工")).at(-1).click();
    $$(document.body, ".dialog-actions button").filter((el) => el.textContent === "收工").at(-1).click(); await until(() => capturing);
    await fixture("postcard-b"); await fixture("postcard-a"); await projectStore.update(startRoomSession(projectStore.get(), "重新打开后的会话"));
    screenshot.resolve(imageData); await tick(); await tick(); await tick();
    assert.equal(projectStore.get().postcards.length, 0);
    assert.equal(projectStore.get().session.goal, "重新打开后的会话");
    assert.equal(projectStore.get().session.endedAt, null);
  } finally { await ui.dispose(); }
});

test("旧项目音频启动的迟到结果不能开启新项目声音偏好", async () => {
  await fixture("audio-a"); const starting = deferred(); let requested = false;
  const audio = fakeAudio(() => { requested = true; return starting.promise; });
  const ui = createAmbience({ projectStore, state, audio, audioFactory: fakeAudio });
  try {
    ui.open(); $$(document.body, ".ambience-audio-head button").at(-1).click(); await until(() => requested);
    await fixture("audio-b"); starting.resolve(); await tick(); await tick(); await tick();
    assert.notEqual(projectStore.get().ambience?.sound, true);
  } finally { await ui.dispose(); }
});

test("旧文件读取返回不能打开到新项目，旧磁盘刷新不能覆盖新项目同名标签", async () => {
  for (const refresh of [false, true]) {
    await fixture(`file-a-${refresh}`); state.set({ tabs: [{ path: "same.ts", text: "A", savedText: "A", revision: "a", dirty: false }] });
    const response = deferred(), base = invoke; let requested = false;
    invoke = async (...args) => { if (args[1].method === "fs.read") { requested = true; return response.promise; } return base(...args); };
    const operation = refresh ? refreshTabFromDisk("same.ts") : openFile("new.ts");
    const settled = operation.catch(() => {}); await until(() => requested);
    await fixture(`file-b-${refresh}`); state.set({ tabs: [{ path: "same.ts", text: "B", savedText: "B", revision: "b", dirty: false }], active: "same.ts" });
    response.resolve({ path: refresh ? "same.ts" : "new.ts", content: "旧项目 A 内容", revision: "old" }); await settled;
    assert.deepEqual(state.get().tabs.map((t) => t.path), ["same.ts"]);
    assert.equal(state.get().tabs[0].text, "B");
  }
});

test("旧保存 RPC 的返回不能把新项目同名文件标为已保存", async () => {
  await fixture("save-a"); state.set({ tabs: [{ path: "same.ts", text: "A修改", savedText: "A", revision: "a", dirty: true }] });
  const response = deferred(), base = invoke; let requested = false;
  invoke = async (...args) => { if (args[1].method === "fs.write") { requested = true; return response.promise; } return base(...args); };
  const saving = saveTab("same.ts").catch(() => {}); await until(() => requested);
  await fixture("save-b"); state.set({ tabs: [{ path: "same.ts", text: "B修改", savedText: "B", revision: "b", dirty: true }] });
  response.resolve({ path: "same.ts", revision: "a-new" }); await saving;
  assert.equal(state.get().tabs[0].savedText, "B"); assert.equal(state.get().tabs[0].revision, "b"); assert.equal(state.get().tabs[0].dirty, true);
});

test("等待工作台加载的上下文构建在项目切换后取消，旧读取不得覆盖新项目", async () => {
  await fixture("loading-before"); const reading = deferred(); let requested = false;
  invoke = async (_, { method }) => { if (method === "studio.read") { requested = true; return reading.promise; } throw new Error(`意外调用：${method}`); };
  state.set({ workspace: { roots: ["/loading-a"], capabilities: { git: false } } });
  await until(() => requested); assert.equal(studioState.get().loading, true);
  const context = buildContext("属于 A 的请求"); const rejected = assert.rejects(context, /项目已切换/);
  await fixture("loading-b"); await rejected;
  reading.resolve({ data: { brief: { goal: "旧 A 的目标" } }, revision: "a", workspace_key: "loading-a-key" }); await tick();
  assert.equal(studioState.get().workspaceKey, "loading-b-key"); assert.equal(projectStore.get().brief.goal, "");
});

test("语言 Worker 的迟到结果在 A 到 B 再回 A 后不能添加旧诊断", async () => {
  await fixture("worker-a"); const previous = globalThis.Worker; let engine, request;
  globalThis.Worker = class { constructor() { engine = this; } postMessage(value) { request = value; } terminate() {} };
  const base = invoke;
  invoke = async (...args) => {
    if (args[1].method === "fs.tree") return { nodes: [{ path: "a.ts", name: "a.ts", type: "file" }] };
    if (args[1].method === "fs.read") return { path: "a.ts", content: "const a = 1", revision: "r1" };
    return base(...args);
  };
  try {
    const { languageRequest } = await import("../../apps/web/src/services/language.js");
    const operation = languageRequest("diagnostics", { path: "a.ts" }); const rejected = assert.rejects(operation, /项目已切换/);
    await until(() => !!request); await fixture("worker-b"); await fixture("worker-a");
    engine.onmessage({ data: { id: request.id, result: { issues: [{ source: "typescript", path: "a.ts", message: "旧工作区错误" }] } } });
    await rejected; assert.deepEqual(studioState.get().issues, []);
  } finally { globalThis.Worker = previous; }
});

test("旧验收证据保存完成不能向新项目发出验证通过事件", async () => {
  await fixture("evidence-a"); const writing = deferred(), base = invoke; let saved;
  invoke = async (...args) => {
    if (args[1].method === "terminal.run") return { id: "late-evidence" };
    if (args[1].method === "studio.write") { saved = structuredClone(args[1].params); return writing.promise; }
    return base(...args);
  };
  const verified = []; const off = events.on("studio:verified", (event) => verified.push(event));
  try {
    await runVerification("check"); emitNative("terminal.output", { id: "late-evidence", source: "user", data: "通过" });
    emitNative("terminal.exit", { id: "late-evidence", source: "user", exit_code: 0 }); await until(() => !!saved);
    assert.equal(saved.workspace_key, "evidence-a-key");
    await fixture("evidence-b"); writing.resolve({ data: saved.data, revision: "a-late", workspace_key: "evidence-a-key" });
    await tick(); await tick(); await tick();
    assert.deepEqual(verified, []); assert.deepEqual(projectStore.get().evidence, []);
  } finally { off(); }
});

test("原生首页显示真实本地连接状态、重试指引和中文提问状态", () => {
  state.set({ workspace: null, conn: "offline", agent: { running: false, state: "idle", detail: "" } });
  const capsule = createCapsule(), welcome = createWelcome({ onOpenSettings() {} });
  assert.equal($$(capsule, ".txt")[0].textContent, "本地环境未连接");
  assert.match(welcome.textContent, /本地环境尚未连接/);
  assert.doesNotMatch(welcome.textContent, /python bridge\/main\.py|手动连接…/);
  state.set({ conn: "connecting" });
  assert.equal($$(capsule, ".txt")[0].textContent, "本地环境连接中…");
  assert.match(welcome.textContent, /正在连接本地环境…/);
  state.set({ conn: "online" });
  assert.equal($$(capsule, ".txt")[0].textContent, "本地环境已就绪");
  state.set({ agent: { running: true, state: "waiting_user", detail: "" } });
  assert.equal($$(capsule, ".txt")[0].textContent, "等待你回答");
  state.set({ agent: { running: false, state: "idle", detail: "" } });
});
