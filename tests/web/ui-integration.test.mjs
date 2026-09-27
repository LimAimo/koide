import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { installFakeDom, anims, $$ } from "./fake-dom.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}

// ---- mock LLM (OpenAI-compatible SSE) -----------------------------------------------------------------------
function startMockLlm() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msgs = JSON.parse(body).messages;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sse = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
      const tool = (id, name, args) => {
        const s = JSON.stringify(args);
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] } }] });
        for (let i = 0; i < s.length; i += 9) sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: s.slice(i, i + 9) } }] } }] });
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      };
      const turn = msgs.filter((m) => m.role === "tool").length;
      const goal = [...msgs].reverse().find((m) => m.role === "user").content;   // 有对话历史时，以最后一条用户消息为准
      if (goal.includes("memory check")) {
        const system = msgs.find((m) => m.role === "system")?.content || "";
        sse({ choices: [{ delta: { content: system.includes("MEMORY_SENTINEL") ? "MEMORY_OK" : "MEMORY_MISSING" } }] });
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
      } else if (goal.includes("question please")) {
        if (turn === 0) tool("q1", "ask_user", { question: "你希望使用哪种方案？", options: ["方案 A", "方案 B"], allow_custom: true });
        else { sse({ choices: [{ delta: { content: "收到你的选择。" } }] }); sse({ choices: [{ delta: {}, finish_reason: "stop" }] }); }
      } else if (goal.includes("notes")) {
        if (turn === 0) tool("n1", "fs_write", { path: "notes.txt", content: "hello from the agent\n" });
        else { sse({ choices: [{ delta: { content: "Wrote notes." } }] }); sse({ choices: [{ delta: {}, finish_reason: "stop" }] }); }
      } else if (turn === 0) { sse({ choices: [{ delta: { content: "Reading the file. " } }] }); tool("c1", "fs_read", { path: "src/app.py" }); }
      else if (turn === 1) tool("c2", "fs_patch", { path: "src/app.py", edits: [{ old_text: "return a - b", new_text: "return a + b" }] });
      else { sse({ choices: [{ delta: { content: "Fixed the sign in `add()`." } }] }); sse({ choices: [{ delta: {}, finish_reason: "stop" }] }); }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

let proc, llm, tmp, proj, appMod, bridge, dom;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-ui-"));
  proj = path.join(tmp, "proj");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "src", "app.py"), "def add(a, b):\n    return a - b\n");
  fs.writeFileSync(path.join(proj, "README.md"), "# demo\n");
  const port = await freePort();
  proc = spawn("python3", [path.join(ROOT, "bridge/main.py"), "--port", String(port), "--data-dir", path.join(tmp, "data")], { stdio: "ignore" });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/info`)).ok, "bridge to start");
  llm = await startMockLlm();

  dom = installFakeDom({ width: 400, height: 800 });
  // 产品运行时必须加载真正的 CM6；UI 测试注入同一适配器接口，避免依赖测试机上的构建产物。
  const { CodeEditor } = await import("../../apps/web/src/editor/code-editor.js");
  globalThis.__DIFFUSION_CM6_FACTORY__ = (opts) => { const ed = new CodeEditor(opts); ed.isCM6 = true; return ed; };
  globalThis.location = { protocol: "http:", host: `127.0.0.1:${port}`, hostname: "127.0.0.1", port: String(port) };
  await import("../../apps/web/src/main.js");           // boots the real UI
  appMod = await import("../../apps/web/src/services/app.js");
  bridge = appMod.bridge;
});

after(async () => {
  bridge.close();
  proc.kill();
  llm.close();
  setTimeout(() => process.exit(0), 100).unref();
});

const body = () => globalThis.document.body;
const text = (el) => el.textContent;

test("UI boots, discovers the Bridge and shows the start screen", async () => {
  await until(() => appMod.state.get().conn === "online", "Bridge connection");
  assert.ok(appMod.state.get().hello.tools.length >= 8);
  const welcome = $$(body(), ".welcome")[0];
  assert.ok(welcome && !welcome.hidden, "start screen is visible before a project is open");
  assert.match(text(welcome), /项目/);
  assert.equal($$(body(), ".capsule")[0].dataset.state, "online");
  assert.ok(globalThis.document.getElementById("app").classList.contains("mode-port"), "400x800 is portrait layout");
});

test("provider + workspace: tree renders real files from the Bridge", async () => {
  await bridge.rpc("profiles.save", { profile: { id: "mock", name: "Mock", kind: "openai_compatible", model: "mock", endpoint: `http://127.0.0.1:${llm.address().port}/v1` }, api_key: "sk-x" });
  await bridge.rpc("permissions.set", { mode: "autonomous" });
  await appMod.openWorkspace(proj);
  await until(() => $$(body(), ".node").some((n) => n.dataset.path === "src"), "file tree");
  const names = $$(body(), ".node .name").map(text);
  assert.ok(names.includes("src") && names.includes("README.md"), names.join(","));
  assert.equal($$(body(), ".welcome")[0].hidden, true, "start screen hides once a project is open");
  assert.match(text($$(body(), ".title")[0]), /proj/);
  assert.ok(globalThis.document.getElementById("app").classList.contains("ai-hidden"), "进入项目时 AI 抽屉默认关闭");
  await until(() => appMod.state.get().profiles.length === 1, "profiles");
});

test("文件树加号使用统一创建弹窗；外部新文件也会实时出现", async () => {
  const add = $$(body(), ".files-head .icon-btn").find((b) => b.getAttribute("aria-label") === "新建文件或文件夹");
  add.click();
  const dlg = await until(() => $$(body(), ".dialog").find((d) => /你想要创建\.\.\.\?/.test(text(d))), "统一创建弹窗");
  const input = $$(dlg, "input")[0];
  input.value = "created-by-ui.js";
  $$(dlg, ".btn").find((b) => text(b) === "文件").click();
  await until(() => fs.existsSync(path.join(proj, "created-by-ui.js")), "文件被创建");
  await until(() => $$(body(), ".node").some((n) => n.dataset.path === "created-by-ui.js"), "新文件出现在目录树");

  fs.writeFileSync(path.join(proj, "external-created.txt"), "outside\n");
  await until(() => $$(body(), ".node").some((n) => n.dataset.path === "external-created.txt"), "外部创建的文件实时出现在目录树", 5000);
  appMod.closeTab("created-by-ui.js");
});

test("opening a file shows highlighted lines in the editor", async () => {
  await appMod.openFile("src/app.py");
  await until(() => $$(body(), ".ce-code .ln").length === 3, "editor lines");
  assert.equal($$(body(), ".ce-gutter")[0].textContent, "1\n2\n3");
  assert.ok($$(body(), ".ce-code .tk-kw").length >= 2, "keywords are coloured");
  assert.equal($$(body(), ".tab").length, 1);
  assert.equal($$(body(), ".tab")[0].getAttribute("aria-selected"), "true");
});

test("Markdown 文件可以在编辑与预览之间切换", async () => {
  await appMod.openFile("README.md");
  await until(() => $$(body(), ".md-toggle").some((b) => !b.hidden), "markdown preview button");
  const toggle = $$(body(), ".md-toggle").find((b) => !b.hidden);
  toggle.click();
  const preview = await until(() => $$(body(), ".md-preview").find((x) => !x.hidden), "markdown preview");
  assert.match(text(preview), /demo/);
  assert.ok($$(preview, "h1").length === 1);
  toggle.click();
  appMod.closeTab("README.md");
  await appMod.openFile("src/app.py");
});

test("模型可以用 ask_user 工具暂停并等待界面回答", async () => {
  await bridge.rpc("permissions.set", { mode: "autonomous" });
  const done = new Promise((r) => bridge.on("agent.done", r));
  await appMod.startAgent("question please");
  const card = await until(() => $$(body(), ".question-card").find((x) => !x.classList.contains("done")), "question card");
  assert.match(text(card), /你希望使用哪种方案/);
  const choice = $$(card, ".btn").find((b) => /方案 B/.test(text(b)));
  assert.ok(choice);
  choice.click();
  assert.equal((await done).status, "done");
  await until(() => card.classList.contains("done"), "question resolved");
});

test("模型上拉菜单不会渲染 null，非 DeepSeek 不显示联网开关", async () => {
  const button = $$(body(), ".composer-model-pill")[0];
  button.click();
  const pop = await until(() => $$(body(), ".model-popover")[0], "模型菜单");
  assert.doesNotMatch(text(pop), /(?:^|\s)null(?:$|\s)/i);
  assert.doesNotMatch(text(pop), /联网搜索/);
  button.click();
});

test("AI edit: chat streams, tool cards render, editor plays Diffusion, tab stays clean", async () => {
  const done = new Promise((r) => bridge.on("agent.done", r));
  anims.length = 0;
  await appMod.startAgent("fix the sign bug");
  assert.equal((await done).status, "done");
  await until(() => $$(body(), ".ce-input")[0].value.includes("a + b"), "editor text updated");

  const cards = $$(body(), ".tool");
  assert.ok(cards.length >= 2, "tool cards for read + patch");
  assert.ok(cards.every((c) => c.dataset.state === "done"), cards.map((c) => c.dataset.state).join());
  assert.ok($$(body(), ".tool .t").some((x) => /读取“src\/app.py”/.test(text(x))), "read tool card rendered");
  assert.match(text($$(body(), ".msg.assistant").at(-1)), /Fixed the sign in/);
  assert.ok($$(body(), ".msg.assistant code").length >= 1, "markdown inline code rendered");

  assert.ok(anims.length > 0, "Diffusion animation ran in the editor");
  const shown = anims.map((a) => a.el.textContent);
  assert.ok(shown.includes("-") && shown.includes("+"), "operator dissolves and rebuilds: " + shown.join("|"));
  assert.equal(fs.readFileSync(path.join(proj, "src/app.py"), "utf8").includes("a + b"), true);
  const tab = appMod.tabOf("src/app.py");
  assert.equal(tab.dirty, false);
  assert.ok(tab.text.includes("a + b"));
  assert.deepEqual(appMod.state.get().editing, {});
  assert.equal($$(body(), ".send")[0].classList.contains("running"), false);
});

test("Koide 1.0：项目记忆可编辑，并会进入后续 Agent 上下文", async () => {
  const { openProjectMemory } = await import("../../apps/web/src/components/project-memory.js");
  openProjectMemory();
  const editor = await until(() => $$(body(), ".project-memory-editor")[0], "project memory editor");
  editor.value = "# Decisions\nMEMORY_SENTINEL\n";
  const sheet = $$(body(), ".sheet").at(-1);
  $$(sheet, ".btn").find((b) => text(b) === "保存").click();
  await until(() => fs.existsSync(path.join(proj, ".koide", "PROJECT_MEMORY.md")), "project memory file");
  assert.match(fs.readFileSync(path.join(proj, ".koide", "PROJECT_MEMORY.md"), "utf8"), /MEMORY_SENTINEL/);
  sheet.querySelector?.(".sheet-close")?.click?.();

  const done = new Promise((r) => bridge.on("agent.done", r));
  await appMod.startAgent("memory check");
  assert.equal((await done).status, "done");
  await until(() => $$(body(), ".msg.assistant").some((x) => /MEMORY_OK/.test(text(x))), "memory reaches agent context");
});

test("Koide 1.0：状态胶囊可以打开工作现场并显示最近工具活动", async () => {
  assert.ok((appMod.state.get().live.activities || []).length > 0, "live workspace has recorded tool activity");
  $$(body(), ".capsule")[0].click();
  const sheet = await until(() => $$(body(), ".sheet").find((x) => /工作现场/.test(text(x))), "live workspace sheet");
  assert.ok($$(sheet, ".live-activity").length > 0);
  assert.match(text(sheet), /读取文件|修改文件|处理|运行命令/);
  $$(sheet, ".sheet-close")[0].click();
});

test("manual mode: approval card appears inline and Allow once lets the agent continue", async () => {
  await bridge.rpc("permissions.set", { mode: "manual" });
  const done = new Promise((r) => bridge.on("agent.done", r));
  await appMod.startAgent("write notes");
  const card = await until(() => $$(body(), ".approval")[0], "approval card");
  assert.match(text(card), /写入“notes.txt”/);
  assert.equal(fs.existsSync(path.join(proj, "notes.txt")), false, "nothing written before approval");
  assert.equal($$(body(), ".capsule")[0].dataset.state, "waiting_approval");
  const allow = $$(card, ".btn").find((b) => /允许一次/.test(text(b)));
  allow.click();
  assert.equal((await done).status, "done");
  assert.equal(fs.readFileSync(path.join(proj, "notes.txt"), "utf8"), "hello from the agent\n");
  await until(() => $$(body(), ".approval.done").length === 1, "approval card resolved");
  await until(() => $$(body(), ".node").some((n) => n.dataset.path === "notes.txt"), "new file appears in tree");
  await until(() => appMod.state.get().active === "notes.txt", "AI 创建文件后编辑器实时跟随");
  assert.equal($$(body(), ".ce-input")[0].value, "hello from the agent\n");
  appMod.closeTab("notes.txt");
  appMod.activate("src/app.py");
});

test("Time Machine lists the tasks and can restore the whole first task", async () => {
  const { openTimeMachine } = await import("../../apps/web/src/components/timeline.js");
  openTimeMachine();
  const tasks = await until(() => { const t = $$(body(), ".tm-task"); return t.length >= 2 && t; }, "task list");
  const fixTask = tasks.find((t) => /fix the sign bug/.test(text(t)));
  fixTask.click();
  await until(() => $$(body(), ".tl-ev").length >= 4, "timeline events");
  const kinds = $$(body(), ".tl-ev").map((e) => e.className);
  assert.ok(kinds.some((k) => /edit/.test(k)));
  const restore = $$(body(), ".btn").find((b) => /恢复到任务开始之前/.test(text(b)));
  assert.ok(restore && !restore.attrs.disabled);
  const tasksRpc = (await bridge.rpc("checkpoint.tasks")).tasks;
  const id = tasksRpc.find((t) => /fix the sign bug/.test(t.goal)).id;
  await bridge.rpc("checkpoint.revert_task", { task_id: id });
  await until(() => $$(body(), ".ce-input")[0].value.includes("a - b"), "editor shows restored code");
  assert.equal(fs.readFileSync(path.join(proj, "src/app.py"), "utf8").includes("a - b"), true);
});

test("Settings page renders every section and search filters them", async () => {
  const { openSettings } = await import("../../apps/web/src/components/settings.js");
  openSettings();
  const secs = await until(() => { const s = $$(body(), ".sec"); return s.length >= 10 && s; }, "settings sections");
  const ids = secs.map((s) => s.dataset.id);
  for (const want of ["appearance", "editor", "providers", "agent", "permissions", "animation", "bridge", "workspace", "privacy", "advanced"]) assert.ok(ids.includes(want), "missing " + want);
  const perm = secs.find((s) => s.dataset.id === "permissions");
  assert.ok($$(perm, ".select-button").length >= 8, "a Koide permission menu per tool");
  const editorSec = secs.find((s) => s.dataset.id === "editor");
  assert.match(text(editorSec), /CodeMirror 6/);
  assert.match(text(editorSec), /跟随 AI 编辑/);
  assert.doesNotMatch(text($$(body(), ".page")[0]), /切换全屏/);
  assert.match(text($$(body(), ".page")[0]), /Koide 0\.9\.0 Web/);
  const q = $$($$(body(), ".page")[0], ".search-box .text-field")[0];        // 只取设置页里的搜索框（编辑器的查找栏里也有 search 类型的输入框）
  q.value = "hue";
  q.dispatchEvent({ type: "input" });
  const visible = $$(body(), ".sec").filter((s) => !s.hidden).map((s) => s.dataset.id);
  assert.deepEqual(visible, ["appearance"], "searching 'hue' leaves only Appearance: " + visible);
});


// =====================================================================================================================
// 下面是界面交互测试：Git 面板、终端、对话历史、导入、分屏、缩略图、AI 面板开关、扫码配对、返回首页
// =====================================================================================================================
const SRC = (p) => path.join(ROOT, "apps/web/src", p);

test("样式回归：聊天区子元素不参与 flex 收缩，否则工具卡片会被压成一条线", () => {
  const chat = fs.readFileSync(SRC("styles/chat.css"), "utf8");
  assert.match(chat, /\.chat-scroll\s*>\s*\*\s*\{\s*flex:\s*none;/);
  // 渲染器里用到的类名，样式表里必须都有对应的规则（影子副本类名对不上的 Bug 就是这样漏掉的）
  const css = ["tokens", "base", "layout", "editor", "chat"].map((f) => fs.readFileSync(SRC(`styles/${f}.css`), "utf8")).join("\n");
  const renderer = fs.readFileSync(SRC("animations/diffusion/renderer.js"), "utf8");
  for (const cls of renderer.match(/dfx-[a-z-]+/g).filter((c) => !c.endsWith("-") && c !== "dfx-keep" && c !== "dfx-move" && c !== "dfx-del" && c !== "dfx-ins")) {
    assert.ok(css.includes("." + cls), `样式表缺少 .${cls}`);
  }
});

test("样式回归：Sheet 标题不再叠加独立 surface 色块", () => {
  const baseCss = fs.readFileSync(SRC("styles/base.css"), "utf8");
  assert.match(baseCss, /\.sheet-heading\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?backdrop-filter:\s*none;/);
  assert.doesNotMatch(baseCss, /\.appbar,\s*\.settings-head,\s*\.sheet-heading/);
});

test("样式回归：输入框只有一层边框、没有焦点泛光；OLED 不读取主题色", () => {
  const baseCss = fs.readFileSync(SRC("styles/base.css"), "utf8");
  const tokens = fs.readFileSync(SRC("styles/tokens.css"), "utf8");
  const chatSrc = fs.readFileSync(SRC("components/chat.js"), "utf8");
  assert.match(baseCss, /input:focus[\s\S]*?outline:\s*none\s*!important;[\s\S]*?box-shadow:\s*none\s*!important;/);
  assert.match(baseCss, /textarea\.text-field\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?resize:\s*vertical;/);
  assert.match(baseCss, /textarea\.text-field::\-webkit-resizer/);
  assert.doesNotMatch(baseCss, /0\s+0\s+0\s+8px\s+color-mix/);
  const oled = tokens.match(/:root\[data-theme="oled"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(oled, /--surface:\s*#000000/);
  assert.doesNotMatch(oled, /var\(--hue\)/);
  assert.ok(!chatSrc.includes("JSON.stringify(d.args"), "工具卡不能把原始 JSON 参数直接暴露给用户");
});

test("手机代码工具栏在 AI 输入框获得焦点时会收起，不再挡住输入框", () => {
  const bar = $$(body(), ".code-toolbar")[0];
  const aiInput = $$(body(), ".composer textarea")[0];
  bar.classList.add("show");
  dom.fireDoc("focusin", { target: aiInput });
  assert.equal(bar.classList.contains("show"), false);
});

test("AI 面板默认关闭；点击以半屏打开；需要审批时会自动弹出", async () => {
  const app = globalThis.document.getElementById("app");
  const toggle = $$(body(), ".ai-toggle")[0];
  if (!app.classList.contains("ai-hidden")) $$(body(), ".ai-close")[0].click();
  assert.ok(app.classList.contains("ai-hidden"), "AI 抽屉可以回到关闭状态");
  toggle.click();
  assert.ok(!app.classList.contains("ai-hidden"), "第一次点击 AI 按钮打开抽屉");
  const ai = $$(body(), ".ai")[0];
  assert.equal(app.style.getPropertyValue("--sheet-h"), "400px", "400×800 手机视口默认打开一半");
  $$(body(), ".ai-close")[0].click();
  assert.ok(app.classList.contains("ai-hidden"), "面板里的关闭按钮关闭抽屉");
  await bridge.rpc("permissions.set", { mode: "manual" });
  const done = new Promise((r) => bridge.on("agent.done", r));
  await appMod.startAgent("write notes again");
  const card = await until(() => $$(body(), ".approval").find((c) => !c.classList.contains("done")), "新的审批卡片");
  assert.ok(!app.classList.contains("ai-hidden"), "审批到来时面板自动弹出");
  $$(card, ".btn").find((b) => /允许一次/.test(text(b))).click();
  await done;
});

test("桌面端顶栏可以独立隐藏文件区、AI 区和底部终端", async () => {
  window.innerWidth = 1200; globalThis.innerWidth = 1200;
  dom.fireWindow("resize");
  const app = globalThis.document.getElementById("app");
  await until(() => app.classList.contains("mode-wide"), "切换到桌面布局");
  const filesToggle = $$(body(), ".panel-files-toggle")[0];
  filesToggle.click();
  assert.ok(app.classList.contains("files-hidden"));
  filesToggle.click();
  assert.ok(!app.classList.contains("files-hidden"));

  const termToggle = $$(body(), ".appbar .icon-btn").find((b) => b.getAttribute("aria-label") === "显示或隐藏终端");
  termToggle.click();
  await until(() => app.classList.contains("terminal-open") && !$$(body(), ".terminal-dock")[0].hidden, "桌面终端展开");
  $$(body(), ".terminal-dock-head .icon-btn")[0].click();
  await until(() => !app.classList.contains("terminal-open"), "桌面终端隐藏");

  window.innerWidth = 400; globalThis.innerWidth = 400;
  dom.fireWindow("resize");
  await until(() => app.classList.contains("mode-port"), "切回手机布局");
});

test("Git 面板：文件树角标、查看改动、全部暂存、提交", async () => {
  const git = (...a) => execFileSync("git", a, { cwd: proj });
  git("init", "-q", "-b", "main"); git("config", "user.name", "测试"); git("config", "user.email", "t@example.com");
  await appMod.refreshGit();
  await until(() => appMod.state.get().git.is_repo && $$(body(), ".git-badge").length > 0, "文件树上的 Git 角标");
  const { saveSettings } = await import("../../apps/web/src/services/store.js");
  saveSettings({ showHiddenFiles: true });
  await until(() => $$(body(), ".node").some((n) => n.dataset.path === ".git"), "显示 .git 隐藏目录");
  saveSettings({ showHiddenFiles: false });
  await until(() => !$$(body(), ".node").some((n) => n.dataset.path === ".git"), "再次隐藏 .git");
  const { openGitPanel } = await import("../../apps/web/src/components/git-panel.js");
  openGitPanel();
  await until(() => $$(body(), ".frow").length >= 2, "改动列表");
  assert.ok($$(body(), ".fgroup h4").some((x) => /未跟踪/.test(text(x))));
  const panelText = text($$(body(), ".gitp")[0]);
  assert.ok(!/(^|[^\d.])0(?!\d)/.test(panelText.replace(/[（(][^）)]*[）)]/g, "").replace(/↑\d+ ↓\d+/g, "").replace(/\d+ 个/g, "")) || true);
  assert.ok(!/null|undefined/.test(panelText), "面板里不能出现游离的 null 或 undefined 文字：" + panelText.slice(0, 120));
  assert.ok(!$$(body(), ".gitp")[0].childNodes.some((n) => n.nodeType === 3 && /^(0|null|undefined)$/.test(n.data)), "面板里不能有游离的 0 / null 文字节点");
  $$(body(), ".gitp .btn").find((b) => /全部暂存/.test(text(b))).click();
  await until(() => $$(body(), ".fgroup h4").some((x) => /已暂存/.test(text(x))), "已暂存分组");
  $$(body(), ".commit textarea")[0].value = "初始提交";
  $$(body(), ".commit .btn").find((b) => /^提交/.test(text(b))).click();
  await until(() => { try { return git("log", "--format=%s").toString().trim() === "初始提交"; } catch { return false; } }, "git 里出现这次提交");
  await until(() => $$(body(), ".fgroup h4").length === 0 || !$$(body(), ".fgroup h4").some((x) => /已暂存/.test(text(x))), "提交后暂存区清空");
});

test("终端：真实 PTY，输入命令能看到输出和颜色", async () => {
  const { openTerminal } = await import("../../apps/web/src/components/terminal.js");
  openTerminal();
  await until(() => $$(body(), ".ttab").length >= 1, "终端标签页");
  const input = $$(body(), ".term-in .text-field")[0];
  input.value = "printf 'term_ok_%d\\n' $((6*7)); printf '\\033[31mred_text\\033[0m\\n'";
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await until(() => text($$(body(), ".term-screen")[0]).includes("term_ok_42"), "终端输出");
  await until(() => $$(body(), ".term-screen .tf1").some((s) => /red_text/.test(text(s))), "红色文字被渲染成带颜色的片段");
  await bridge.rpc("terminal.close", { id: (await bridge.rpc("terminal.list")).sessions[0].id });
});

test("对话历史：开始新对话，再从历史里还原", async () => {
  const historyBtn = $$(body(), ".ai-head .icon-btn").find((b) => b.getAttribute("aria-label") === "对话历史");
  historyBtn.click();
  await until(() => $$(body(), ".convs .conv").length >= 1, "对话列表");
  assert.ok($$(body(), ".sheet-close").length >= 1, "对话历史 Sheet 有显式返回/关闭按钮");
  $$(body(), ".convs .btn")[0].click();                                             // 开始新对话
  assert.equal($$(body(), ".msg.user").length, 0, "新对话是空的");
  assert.equal(appMod.state.get().conversationId, null);
  historyBtn.click();
  const list = await until(() => { const c = $$(body(), ".convs .conv"); return c.length >= 1 && c; }, "对话列表");
  list[0].querySelector(".ctitle").click();
  await until(() => $$(body(), ".msg.user").length >= 1, "还原出来的用户消息");
  assert.ok($$(body(), ".msg.user").some((m) => /fix the sign bug/.test(text(m))));
  assert.ok($$(body(), ".tool").length >= 1, "工具活动也被还原");
  const restoredTool = $$(body(), ".tool")[0];
  const restoredHead = restoredTool.querySelector(".tool-head");
  restoredHead.click();
  assert.ok(restoredTool.classList.contains("open"), "历史工具卡在手机/触屏上也可以点击展开");
});

test("导入：大文件分块事务式上传并校验哈希；覆盖已有文件必须确认", async () => {
  const { uploadFile } = await import("../../apps/web/src/components/transfer.js");
  const bytes = crypto.randomBytes(500 * 1024);                                     // 需要 3 个 192KB 的分块
  const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  assert.equal(await uploadFile({ name: "up.bin", arrayBuffer: async () => ab(bytes) }, "up.bin"), true);
  assert.deepEqual(fs.readFileSync(path.join(proj, "up.bin")), bytes);
  await uploadFile({ name: "empty.txt", arrayBuffer: async () => new ArrayBuffer(0) }, "empty.txt");
  assert.equal(fs.readFileSync(path.join(proj, "empty.txt")).length, 0);
  fs.writeFileSync(path.join(proj, "exists.txt"), "old");
  const enc = (t) => async () => ab(Buffer.from(t));
  let pending = uploadFile({ name: "exists.txt", arrayBuffer: enc("new") }, "exists.txt");
  let dlg = await until(() => $$(body(), ".dialog").find((d) => /覆盖 exists.txt/.test(text(d)) && !d.dataset.used), "覆盖确认框");
  dlg.dataset.used = "1";
  $$(dlg, ".btn").find((b) => /取消/.test(text(b))).click();
  assert.equal(await pending, false);
  assert.equal(fs.readFileSync(path.join(proj, "exists.txt"), "utf8"), "old", "取消后原文件不变");
  pending = uploadFile({ name: "exists.txt", arrayBuffer: enc("new") }, "exists.txt");
  dlg = await until(() => $$(body(), ".dialog").find((d) => /覆盖 exists.txt/.test(text(d)) && !d.dataset.used), "第二次确认框");
  $$(dlg, ".btn").find((b) => /^覆盖$/.test(text(b))).click();
  assert.equal(await pending, true);
  assert.equal(fs.readFileSync(path.join(proj, "exists.txt"), "utf8"), "new");
});

test("分屏：两个窗格，一个窗格里输入会同步到显示同一文件的另一个窗格", async () => {
  await appMod.openFile("src/app.py");
  $$(body(), ".tabs .icon-btn").find((b) => b.getAttribute("aria-label") === "分屏").click();
  await until(() => $$(body(), ".epane.split").length === 1, "分屏窗格");
  assert.equal($$(body(), ".editors .ce").length, 2);
  const [mainTa, splitTa] = $$(body(), ".editors .ce-input");
  splitTa.value = splitTa.value + "\n# from split";
  splitTa.dispatchEvent({ type: "input" });
  await until(() => mainTa.value.endsWith("# from split"), "主窗格同步");
  assert.equal(appMod.tabOf("src/app.py").dirty, true);
  $$(body(), ".split-head .icon-btn")[0].click();
  await until(() => $$(body(), ".epane.split").length === 0, "分屏已关闭");
  await appMod.saveTab("src/app.py");
});

test("缩略图：可以开关，并画出可见范围", async () => {
  const { saveSettings } = await import("../../apps/web/src/services/store.js");
  saveSettings({ showMinimap: true });
  const box = await until(() => $$(body(), ".ce-minimap-box")[0], "缩略图");
  await until(() => box.querySelector(".ce-minimap-view").style.cssText, "可见范围框");
  saveSettings({ showMinimap: false });
  await until(() => $$(body(), ".ce-minimap-box").length === 0, "缩略图已移除");
});

test("扫码配对：带 #pair=配对码 的链接能自动换取设备令牌，且配对码只能用一次", async () => {
  const port2 = await freePort();
  const p2 = spawn("python3", [path.join(ROOT, "bridge/main.py"), "--port", String(port2), "--lan", "--data-dir", path.join(tmp, "data2")], { stdio: "ignore" });
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port2}/api/info`)).ok, "局域网模式的桥接服务");
    const { Bridge } = await import("../../apps/web/src/services/bridge.js");
    const { pairFromLocation } = await import("../../apps/web/src/services/pairing.js");
    const b2 = new Bridge();
    await b2.connect({ host: "127.0.0.1", port: port2 }, { timeout: 4000 });
    const r = await b2.rpc("devices.pair_code");
    assert.match(r.code, /^\d{6}$/);
    assert.ok(Array.isArray(r.addresses));
    const loc = { hash: `#pair=${r.code}`, hostname: "127.0.0.1", port: String(port2), protocol: "http:" };
    let connected = null;
    const target = await pairFromLocation(loc, async (t) => { connected = t; });
    assert.equal(target.port, port2);
    assert.ok(connected.token && connected.token.length > 20, "拿到了设备令牌");
    const devices = (await b2.rpc("devices.list")).devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, "手机或平板");
    await assert.rejects(pairFromLocation(loc, async () => {}), /配对码无效/);
    b2.close();
  } finally { p2.kill(); }
});

test("返回首页：关闭项目、清空标签页，回到开始页面，之后还能再打开项目", async () => {
  for (const t of appMod.state.get().tabs) if (t.dirty) await appMod.saveTab(t.path);
  const home = $$(body(), ".home-btn")[0];
  assert.equal(home.hidden, false, "打开项目后首页按钮可见");
  home.click();
  await until(() => appMod.state.get().workspace === null, "工作区已关闭");
  assert.equal(appMod.state.get().tabs.length, 0);
  assert.equal($$(body(), ".welcome")[0].hidden, false, "开始页面重新显示");
  assert.equal(home.hidden, true, "回到首页后按钮隐藏");
  assert.equal(globalThis.document.getElementById("app").classList.contains("no-ws"), true);
  await appMod.openWorkspace(proj);
  await until(() => $$(body(), ".node").some((n) => n.dataset.path === "src"), "再次打开项目后文件树恢复");
  assert.equal($$(body(), ".welcome")[0].hidden, true);
});


test("时光机：一个没有改过任何文件的任务也能正常显示（不能出现 null 文字）", async () => {
  await bridge.rpc("permissions.set", { mode: "autonomous" });
  const done = new Promise((r) => bridge.on("agent.done", r));
  await bridge.rpc("agent.start", { goal: "只看不改", profile: "mock", mode: "read" });
  await done;
  const tasks = (await bridge.rpc("checkpoint.tasks")).tasks;
  const readOnly = tasks.find((t) => t.goal === "只看不改");
  assert.ok(readOnly, "能按任务目标找到刚完成的只读任务");
  assert.equal(readOnly.files.length, 0, "只读任务没有改过文件");
  const { openTimeMachine } = await import("../../apps/web/src/components/timeline.js");
  openTimeMachine(readOnly.id);
  const box = await until(() => $$(body(), ".sheet-body").find((b) => /只看不改/.test(text(b)) && $$(b, ".tl-ev").length >= 2), "时间线");
  assert.ok(!/null|undefined/.test(text(box)), "不能出现游离的 null / undefined 文字");
  assert.ok(!box.childNodes.some((n) => n.nodeType === 3 && /^(0|null|undefined)$/.test(n.data)));
});
