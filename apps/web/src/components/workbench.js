import { h, clear, toast } from "./dom.js";
import { promptDialog, confirmDialog, openSheet } from "./overlays.js";
import { runtime, state, events, openFile, startAgent, stopAgent } from "../services/app.js";
import { projectStore, studioState, getProjectEpoch, assertProjectEpoch, runVerification, cancelVerification, refreshCodeRevision, evidenceStatus, addIssue, clearIssues, repairIssue, addAttachment } from "../services/studio.js";
import { manualStatus } from "../services/studio-model.js";

const labels = [["task", "目标与验收"], ["run", "运行"], ["preview", "预览"], ["issues", "问题"], ["memory", "记忆"], ["style", "风格"], ["experiments", "方案"], ["control", "指挥台"]];
const button = (text, fn, variant = "tonal", bindProject = true) => { const epoch = getProjectEpoch(); return h("button", { class: `btn ${variant}`, type: "button", onclick: () => Promise.resolve().then(() => { if (bindProject) assertProjectEpoch(epoch); return fn(); }).catch((e) => toast(e.message)) }, text); };
const projectParams = () => studioState.get().workspaceKey ? { workspace_key: studioState.get().workspaceKey } : {};
const field = (label, value, fn, options = {}) => { const input = h(options.multiline ? "textarea" : "input", { class: "text-field", value: value || "", rows: options.rows || 3, type: "text", "aria-label": label, placeholder: options.placeholder || "", onchange: () => Promise.resolve(fn(input.value)).catch((e) => toast(e.message)) }); if (options.multiline) input.value = value || ""; return h("label", { class: "studio-field" }, h("span", null, label), input); };
const card = (title, ...body) => h("section", { class: "studio-card" }, h("h3", null, title), ...body);
const hint = (text) => h("p", { class: "studio-muted" }, text);
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function createWorkbench({ onClose, onOpenTimeline }) {
  let active = "task", visible = false, inspector = null, frame = null, preview = null, generation = 0;
  let picking = false, pickerButton = null, previewLog = null, previewMessages = [];
  function syncPicker() {
    frame?.contentWindow?.postMessage({ type: "koide.preview.control", token: preview?.token, inspect: picking }, "*");
    if (pickerButton) { pickerButton.textContent = picking ? "取消元素选择" : "选择页面元素"; pickerButton.setAttribute("aria-pressed", String(picking)); }
  }
  const body = h("div", { class: "studio-body" }), tabs = h("nav", { class: "studio-tabs", "aria-label": "创作工作台" });
  const title = h("div", null, h("strong", null, "创作工作台"), h("span", { class: "studio-muted" }, "  把想法做成看得见的作品"));
  const status = h("div", { class: "studio-status", role: "status" });
  const el = h("section", { class: "studio-workbench", hidden: true, "aria-label": "创作工作台" }, h("header", { class: "studio-heading" }, title, button("返回代码", () => { hide(); onClose?.(); }, "text", false)), tabs, status, body);
  for (const [id, text] of labels) tabs.append(button(text, () => { active = id; render(); }, "text", false));
  function render() {
    if (!visible) return;
    generation++;
    clear(body);
    [...tabs.children].forEach((b, i) => b.setAttribute("aria-current", labels[i][0] === active ? "page" : "false"));
    status.textContent = studioState.get().loading ? "正在读取项目…" : studioState.get().error || "所有项目修改均可通过时光机追溯";
    ({ task: renderTask, run: renderRun, preview: renderPreview, issues: renderIssues, memory: renderMemory, style: renderStyle, experiments: renderExperiments, control: renderControl })[active]();
  }
  function renderTask() {
    const epoch = getProjectEpoch();
    const p = projectStore.get(), brief = p.brief || {};
    const save = (patch) => { assertProjectEpoch(epoch); return projectStore.update({ brief: { ...projectStore.get().brief, ...patch } }); };
    body.append(card("这次想做出什么", field("目标", brief.goal, (goal) => save({ goal }), { multiline: true, placeholder: "例如：做一个支持离线保存的记账工具" }), field("边界与不能改的部分", brief.constraints, (constraints) => save({ constraints }), { multiline: true }), button("从目标生成验收草稿", () => {
      const goal = projectStore.get().brief.goal;
      if (!goal) throw new Error("先填写这次的目标");
      return startAgent(`请分析需求，根据以下目标给出精简的验收条件和关键未知项，供我填写任务卡。目标：${goal}`, { mode: "read", freshConversation: true });
    }), button("开始实现这个目标", () => { if (!brief.goal) throw new Error("先填写目标"); return startAgent(brief.goal); }, "filled")));
    const criteria = card("验收条件", hint("命令验证与人工体验分别记录，人工勾选不会伪装成测试通过。"));
    for (const c of brief.criteria || []) {
      const status = manualStatus(c, studioState.get().codeRevision);
      criteria.append(h("div", { class: "studio-criterion" }, h("strong", null, c.text), c.command ? h("code", null, c.command) : hint("人工体验项"),
        hint({ pending: "尚未人工验收", accepted: "当前代码已人工验收", stale: "代码版本已变化或尚未检查，请重新人工验收" }[status]),
        button(status === "accepted" ? "取消人工验收" : "确认人工体验通过", async () => {
          const revision = await refreshCodeRevision();
          return save({ criteria: (projectStore.get().brief.criteria || []).map((x) => x.id === c.id ? { ...x, manual_accepted: status !== "accepted", accepted_revision: revision, accepted_at: new Date().toISOString() } : x) });
        }), c.command ? button("执行验证", () => runVerification(c.command, c.id)) : null,
        button("删除条件", () => save({ criteria: (projectStore.get().brief.criteria || []).filter((x) => x.id !== c.id) }), "text")));
    }
    criteria.append(button("添加验收条件", async () => { const text = await promptDialog({ title: "添加验收条件", label: "怎样判断已经完成" }); if (!text) return; const command = await promptDialog({ title: "验证命令（可留空）", label: "命令将在项目目录执行" }); await save({ criteria: [...(projectStore.get().brief.criteria || []), { id: uid(), text, command: command || "", manual_accepted: false }] }); }));
    body.append(criteria);
    const evidence = card("真实验证记录", button("检查记录是否仍有效", () => refreshCodeRevision()));
    for (const e of [...(p.evidence || [])].reverse().slice(0, 20)) {
      const kind = evidenceStatus(e, studioState.get().codeRevision), label = { passed: "通过", failed: "失败", stale: "需重新验证" }[kind];
      evidence.append(h("details", { class: `studio-evidence ${kind}` }, h("summary", null, `${label} · ${e.command} · ${new Date(e.at).toLocaleString("zh-CN")}`), h("p", null, `退出码：${e.exit_code} · ${e.cancelled ? "已取消 · " : e.timed_out ? "已超时 · " : ""}代码版本：${String(e.revision).slice(0, 12)}`), h("pre", null, e.output || "命令没有输出"), e.output_truncated ? hint("较早的输出已缩短，验证状态仍保留") : null, button("重新验证", () => runVerification(e.command, e.criterion_id, { cwd: e.cwd || "." }))));
    }
    if (!(p.evidence || []).length) evidence.append(hint("还没有验证记录。AI 调用过工具，仍需要验证实际行为。"));
    body.append(evidence);
  }
  function renderRun() {
    const epoch = getProjectEpoch(), params = projectParams();
    const box = card("项目运行向导", hint("读取配置并检查环境，不会自行安装依赖或执行脚本。"), button("重新检查", async () => { const r = await runtime.launch.inspect(params); assertProjectEpoch(epoch); inspector = r; render(); }));
    body.append(box);
    if (!inspector) { const g = generation; runtime.launch.inspect(params).then((r) => { if (g !== generation || epoch !== getProjectEpoch()) return; inspector = r; render(); }).catch((e) => { if (g === generation) box.append(hint(e.message)); }); return; }
    box.append(hint(`项目类型：${inspector.project_type || inspector.kind || "通用项目"}`));
    for (const env of inspector.environment || []) box.append(h("p", null, `${env.available ? "✓" : "○"} ${env.name}：${env.detail || (env.available ? "可用" : "未安装")}`));
    for (const notice of inspector.notices || []) box.append(hint(notice));
    for (const cmd of inspector.commands || []) box.append(h("div", { class: "studio-command" }, h("strong", null, cmd.name || cmd.label), h("code", null, cmd.command), hint(`目录：${cmd.cwd || "."}${cmd.needs_install ? " · 依赖尚未安装" : ""}`), cmd.needs_install ? button("安装此目录依赖", () => runVerification("pnpm install", null, { cwd: cmd.cwd || "." })) : null, button("运行", () => runVerification(cmd.command, null, { cwd: cmd.cwd || ".", timeout: cmd.kind === "run" ? 3600 : 600 }), "filled")));
    box.append(button("执行自定义命令", async () => { const command = await promptDialog({ title: "运行项目命令", label: "在当前项目目录执行" }); assertProjectEpoch(epoch); if (command) await runVerification(command); }));
    for (const run of studioState.get().commands) body.append(card(`执行中：${run.command}`, h("pre", null, run.output || "等待输出…"), button("停止命令", () => cancelVerification(run.id), "text")));
  }
  function renderPreview() {
    const epoch = getProjectEpoch(), params = projectParams();
    const controls = card("看着产品改", hint("预览使用独立隔离页面，页面脚本不能调用 IDE Runtime。"));
    const address = h("input", { class: "text-field", type: "url", value: preview?.upstream || "http://127.0.0.1:3000", "aria-label": "本机开发预览地址" });
    controls.append(address, button("打开预览", async () => {
      const previous = preview;
      const next = await runtime.preview.open({ ...params, url: address.value, public_host: globalThis.location?.hostname });
      if (epoch !== getProjectEpoch()) { await runtime.preview.close({ id: next.id }).catch(() => {}); throw new Error("项目已切换，原预览已关闭"); }
      if (previous) await runtime.preview.close({ id: previous.id }).catch(() => {});
      assertProjectEpoch(epoch);
      preview = { ...next, upstream: address.value }; picking = false; previewMessages = []; studioState.set({ preview }); render();
    }, "filled"), button("上传参考图", () => events.emit("studio:pick-image")), button("圈选参考图", () => events.emit("studio:annotate-image")));
    body.append(controls);
    if (!preview) { body.append(hint("先运行开发服务，再打开其本机 HTTP 地址。手机通过已配对的 Bridge 查看电脑上的预览。")); return; }
    pickerButton = button("选择页面元素", () => { picking = !picking; syncPicker(); });
    const toolbar = h("div", { class: "studio-preview-tools" }, button("刷新", () => { if (frame) frame.src = preview.url; }), pickerButton, button("桌面", () => { frame.style.width = "100%"; }), button("手机", () => { frame.style.width = "390px"; }), button("截图并附加", async () => {
      const r = await runtime.preview.capture({ ...params, id: preview.id, width: 1280, height: 800 });
      assertProjectEpoch(epoch);
      addAttachment({ name: "产品预览截图", data_url: r.data_url }); toast("截图已加入本轮上下文");
    }));
    frame = h("iframe", { class: "studio-preview-frame", src: preview.url, sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: "隔离的产品预览", onload: syncPicker });
    previewLog = h("pre", null, previewMessages.join("\n"));
    body.append(toolbar, h("div", { class: "studio-preview-stage" }, frame), hint("点击「选择页面元素」后，再点击产品中的元素，把布局资料附加给 AI。"), h("details", null, h("summary", null, "预览运行日志"), previewLog));
  }
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (!preview || !frame || event.origin !== "null" || event.source !== frame.contentWindow || d?.type !== "koide.preview" || d.token !== preview.token) return;
    if (d.event === "element") {
      const text = JSON.stringify(d.data).slice(0, 12000);
      picking = false; syncPicker();
      studioState.set((s) => ({ selections: [...s.selections.slice(-7), { path: "预览元素", text }] })); toast("页面元素已加入本轮上下文");
    } else if (["console", "error"].includes(d.event)) {
      const message = String(d.data?.message || d.data?.text || JSON.stringify(d.data)).slice(0, 12000);
      previewMessages.push(`${d.data?.level || "error"}：${message}`); previewMessages = previewMessages.slice(-80);
      if (previewLog) previewLog.textContent = previewMessages.join("\n").slice(-60000);
      if (d.event === "error" || ["warn", "error"].includes(d.data?.level)) addIssue({ source: "browser", message });
    }
    else if (d.event === "screenshot") { try { addAttachment({ name: "页面截图", data_url: d.data?.data_url }); } catch (e) { toast(e.message); } }
  });
  function renderIssues() {
    body.append(card("项目问题", button("检查 JS / TS", () => events.emit("studio:language", "diagnostics")), button("清空列表", () => { clearIssues(); render(); }, "text")));
    const issues = studioState.get().issues;
    if (!issues.length) body.append(hint("没有已采集的问题。可运行构建、检查代码或打开预览采集错误。"));
    for (const i of issues) body.append(card(`${i.source} · ${i.path || "运行时"}${i.line ? `:${i.line}` : ""}`, h("pre", null, i.message), i.path ? button("定位文件", async () => { await openFile(i.path); events.emit("editor:reveal", { path: i.path, offset: i.offset || 0 }); }) : null, button("让 AI 修复并验证", () => repairIssue(i), "filled")));
  }
  function renderMemory() {
    const epoch = getProjectEpoch();
    const p = projectStore.get();
    const memories = card("项目记忆", hint("只有你保存的记录会进入后续任务。出处和失效状态始终可见。"), button("添加记忆", async () => { const text = await promptDialog({ title: "项目记忆", label: "决定、原因或踩坑记录" }); if (!text) return; const source = await promptDialog({ title: "记忆出处", label: "文件、会话或你的说明" }); assertProjectEpoch(epoch); await projectStore.update((p) => ({ ...p, memories: [...p.memories, { id: uid(), text, source: source || "用户记录", active: true, stale: false, at: new Date().toISOString() }] })); }));
    for (const m of p.memories || []) memories.append(h("div", { class: "studio-memory" }, h("p", null, m.text), hint(`出处：${m.source} · ${m.stale ? "已失效" : m.active === false ? "未启用" : "本轮会使用"}`), button(m.active === false ? "启用" : "停用", () => projectStore.update((p) => ({ ...p, memories: p.memories.map((x) => x.id === m.id ? { ...x, active: x.active === false } : x) }))), button(m.stale ? "恢复有效" : "标记失效", () => projectStore.update((p) => ({ ...p, memories: p.memories.map((x) => x.id === m.id ? { ...x, stale: !x.stale } : x) }))), button("删除", () => projectStore.update((p) => ({ ...p, memories: p.memories.filter((x) => x.id !== m.id) })), "text")));
    const context = card("本轮文件上下文", hint("发送时重新读取文件内容和 revision；不会只把文件名告诉模型。"), button("添加当前文件", () => { const path = state.get().active; if (!path) throw new Error("先打开文件"); return projectStore.update({ context: [...new Set([...(p.context || []), path])] }); }), button("添加编辑器选区", () => events.emit("studio:attach-selection")));
    for (const path of p.context || []) context.append(h("div", { class: "studio-command" }, h("code", null, path), button("移除", () => projectStore.update({ context: projectStore.get().context.filter((x) => x !== path) }), "text")));
    body.append(memories, context);
  }
  function renderStyle() {
    const epoch = getProjectEpoch();
    const s = projectStore.get().style || {}, save = (key, value) => { assertProjectEpoch(epoch); return projectStore.update({ style: { ...projectStore.get().style, [key]: value } }); };
    body.append(card("项目风格卡", hint("每次 AI 任务都会携带这张卡，让页面保持一致。参考图片可通过聊天附件加入。"), ...[["colors", "配色与设计变量"], ["typography", "字体与文字层级"], ["spacing", "间距、圆角与组件规则"], ["references", "参考说明与风格边界"]].map(([key, name]) => field(name, s[key], (v) => save(key, v), { multiline: true })), button("添加参考图片", () => events.emit("studio:pick-image"))));
  }
  function renderExperiments() {
    const epoch = getProjectEpoch(), params = projectParams();
    const root = state.get().workspace?.location?.path || state.get().workspace?.roots?.[0] || "";
    const origin = String(root).replaceAll("\\", "/").match(/^(.*)\/\.koide\/experiments\/[a-f0-9]+\/work\/?$/)?.[1];
    async function switchProject(path) {
      if (state.get().agent.running) throw new Error("先停止当前 AI 任务再切换方案");
      const dirty = state.get().tabs.filter((t) => t.dirty);
      if (dirty.length && !await confirmDialog({ title: "切换项目？", message: `有 ${dirty.length} 个文件尚未保存，切换会丢弃编辑器中的未保存内容。`, confirmLabel: "仍然切换", danger: true })) return;
      assertProjectEpoch(epoch);
      const { openWorkspace } = await import("../services/app.js");
      await openWorkspace(path); active = "experiments"; render();
    }
    if (origin) {
      body.append(card("正在隔离方案中工作", hint("这里的代码、依赖和验收记录独立保存。返回主项目后可比较并应用结果。"), button("返回主项目比较方案", () => switchProject(origin), "filled")));
      return;
    }
    const panel = card("同基线方案试验", hint("方案有自己的隔离目录。先在方案中修改并验证，选定后检查冲突，再应用到主项目。依赖需要在方案目录单独安装。"), button("从当前基线建立方案", async () => { const name = await promptDialog({ title: "方案名称", label: "例如：极简首页" }); assertProjectEpoch(epoch); if (name) { await runtime.experiments.create({ ...params, name }); assertProjectEpoch(epoch); render(); } }));
    body.append(panel); const g = generation;
    runtime.experiments.list(params).then((r) => {
      if (g !== generation || epoch !== getProjectEpoch()) return;
      const items = r.experiments || r.items || [];
      if (items.length > 1) {
        const choose = (label) => h("select", { class: "text-field", "aria-label": label }, ...items.map((x) => h("option", { value: x.id }, x.name)));
        const left = choose("方案 A"), right = choose("方案 B"); right.value = items[1].id;
        panel.append(card("并排比较两个方案", left, right, button("比较 A / B", async () => {
          const a = items.find((x) => x.id === left.value), b = items.find((x) => x.id === right.value);
          if (!a || !b || a.id === b.id) throw new Error("请选择两个不同方案");
          if (!a.baseline_revision || a.baseline_revision !== b.baseline_revision) throw new Error("这两个方案的基线不同，请从已有方案的同一基线新建第二个方案");
          const [da, db] = await Promise.all([runtime.experiments.diff({ ...params, id: a.id }), runtime.experiments.diff({ ...params, id: b.id })]);
          assertProjectEpoch(epoch);
          const aa = new Map((da.files || da.changes || []).map((f) => [f.path, f])), bb = new Map((db.files || db.changes || []).map((f) => [f.path, f]));
          const view = h("div", null, hint("以下为相同原始基线上的实际文件内容。未修改的一侧显示基线内容。"));
          for (const path of new Set([...aa.keys(), ...bb.keys()])) {
            const x = aa.get(path), y = bb.get(path), baseline = x?.before ?? y?.before ?? "";
            view.append(h("details", { open: true }, h("summary", null, path), h("div", { class: "studio-compare" }, card(a.name, h("pre", null, x ? x.after : baseline)), card(b.name, h("pre", null, y ? y.after : baseline))), x?.binary || y?.binary ? hint("二进制文件请进入对应方案预览") : null, x?.content_truncated || y?.content_truncated ? hint("大文件内容已截断；实际应用使用完整文件") : null));
          }
          openSheet({ title: `${a.name} / ${b.name}`, body: view, tall: true });
        })));
      }
      for (const x of items) panel.append(h("div", { class: "studio-experiment" }, h("h4", null, x.name), hint(`隔离目录：${x.workspace_path || x.id}`),
        button("进入方案", () => { if (!x.absolute_path) throw new Error("执行端没有提供可信方案目录，请更新执行端"); return switchProject(x.absolute_path); }),
        button("从同一基线新建另一方案", async () => { const name = await promptDialog({ title: "同基线方案名称", label: "新方案从原始基线开始，便于公平比较" }); assertProjectEpoch(epoch); if (name) { await runtime.experiments.create({ ...params, name, baseline_id: x.id }); assertProjectEpoch(epoch); render(); } }),
        button("比较主项目与方案", async () => {
          const diff = await runtime.experiments.diff({ ...params, id: x.id }); assertProjectEpoch(epoch); const files = diff.files || diff.changes || [];
          const view = h("div", null, hint(`共 ${files.length} 项变化${diff.has_conflicts ? "，存在主项目冲突，需要先处理" : ""}`));
          for (const f of files) view.append(h("details", null, h("summary", null, `${f.conflict ? "冲突 · " : ""}${f.status || "修改"} · ${f.path}`), card("原始基线", h("pre", null, f.before || "")), card("方案内容", h("pre", null, f.after || "")), f.binary ? hint("二进制文件") : null, f.content_truncated ? hint("大文件内容已截断；实际应用使用完整文件") : null));
          openSheet({ title: `方案比较：${x.name}`, body: view, tall: true });
        }),
        button("应用方案", async () => { if (!(await confirmDialog({ title: "应用方案？", message: "将检查基线冲突并建立恢复检查点，再把方案的真实文件变化应用到当前项目。", confirmLabel: "检查并应用" }))) return; assertProjectEpoch(epoch); const r = await runtime.experiments.apply({ ...params, id: x.id }); assertProjectEpoch(epoch); events.emit("studio:checkpoint", { taskId: r.task_id }); toast("方案已应用，可在时光机恢复"); }, "filled")));
      if (!items.length) panel.append(hint("还没有方案，先从当前代码建立第一个基线。"));
    }).catch((e) => panel.append(hint(e.message)));
  }
  function renderControl() {
    const a = state.get().agent, s = studioState.get();
    body.append(card("手机任务指挥台", h("p", null, state.get().conn === "online" ? "已连接执行端" : "连接已断开，当前状态可能过期"), h("p", null, `任务：${a.running ? a.detail || "正在工作" : "当前没有运行中的任务"}`), button("查看对话、提问与审批", () => events.emit("studio:show-chat")), a.running ? button("停止任务", () => stopAgent(), "text") : null, a.taskId ? button("查看任务改动", () => onOpenTimeline?.(a.taskId)) : null, button("查看产品预览", () => { active = "preview"; render(); }), button("查看验收证据", () => { active = "task"; render(); })));
    const u = s.usage;
    body.append(card("本任务模型用量", u ? h("p", null, `输入：${u.input_tokens ?? u.prompt_tokens ?? "未知"} · 输出：${u.output_tokens ?? u.completion_tokens ?? "未知"} · ${u.cost_usd == null ? "费用未知（可在模型设置填写单价）" : `按配置单价估算 $${Number(u.cost_usd).toFixed(5)}`}`) : hint("等待 Provider 返回实际用量。未提供时显示未知。"), hint("独立审批模型用量不计入此处。预算上限在「设置 › 智能体」配置。手机远程任务沿用配对设备权限，断线不会自动同意审批。")));
  }
  projectStore.subscribe(() => { if (visible && !["preview", "experiments"].includes(active)) render(); });
  let shownRevision;
  studioState.subscribe((s) => { status.textContent = s.loading ? "正在读取项目…" : s.error || ""; const changed = s.codeRevision !== shownRevision; shownRevision = s.codeRevision; if (visible && (["issues", "control", "run"].includes(active) || (active === "task" && changed))) render(); });
  let projectKey;
  state.subscribe((s) => {
    const next = JSON.stringify(s.workspace?.location || s.workspace?.roots || null);
    if (next !== projectKey) { projectKey = next; inspector = null; preview = null; frame = null; picking = false; previewMessages = []; generation++; if (!s.workspace) { hide(); onClose?.(); } else if (visible) render(); }
    else if (visible && active === "control") render();
  });
  function show(tab = active) { visible = true; active = labels.some(([id]) => id === tab) ? tab : "task"; el.hidden = false; render(); if (active === "task") refreshCodeRevision().then(() => { if (visible && active === "task") render(); }).catch((e) => toast(e.message)); }
  function hide() { visible = false; el.hidden = true; }
  return { el, show, hide, get visible() { return visible; } };
}
