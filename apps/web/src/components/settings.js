// Settings: a full-screen page with searchable sections. Configuration can be exported / imported as JSON.

import { h, icon, iconButton, clear, toast } from "./dom.js";
import { pushLayer, openSheet, openDialog, openMenu, confirmDialog } from "./overlays.js";
import { openReplay } from "./timeline.js";
import { runtime, state, connectManual, openWorkspace } from "../services/app.js";
import { settingsStore, saveSettings, exportSettings, importSettings, resetSettings, applyTheme, reducedMotion } from "../services/store.js";
import { emitFeedback, previewFeedback } from "../services/feedback.js";
import { listPacks, installPack, KINDS } from "../animations/diffusion/packs.js";
import { qrSvg } from "../services/qr.js";

// ---- control builders ------------------------------------------------------------------------------------
const search = (...parts) => parts.filter(Boolean).join(" ").toLowerCase();

function row({ label, desc, ctl, stack = false, keywords = "" }) {
  return h("div", { class: "srow" + (stack ? " stack" : ""), dataset: { search: search(label, desc, keywords) } },
    h("div", { class: "lbl" }, label, desc ? h("small", null, desc) : null), ctl ? h("div", { class: "ctl" + (stack ? " grow" : "") }, ctl) : null);
}
function btnRow(label, iconName, onClick, keywords = "") {
  return h("button", { class: "row-btn", type: "button", onclick: onClick, dataset: { search: search(label, keywords) } }, icon(iconName, 20), h("span", null, label));
}
function switchCtl(value, onChange, label) {
  const input = h("input", { type: "checkbox", role: "switch", "aria-label": label });
  input.checked = !!value;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "switch" }, input, h("span", { class: "track" }), h("span", { class: "thumb" }));
}
function selectCtl(options, value, onChange, label) {
  let current = String(value ?? "");
  const button = h("button", { class: "select-button", type: "button", "aria-label": label, "aria-haspopup": "menu" });
  const paint = () => {
    const found = options.find(([v]) => String(v) === current);
    clear(button);
    button.append(h("span", null, found?.[1] ?? current), icon("chevron", 18));
  };
  button.addEventListener("click", () => openMenu(label, options.map(([v, text]) => ({
    label: text,
    icon: String(v) === current ? "check" : null,
    onClick: () => { current = String(v); paint(); onChange(current); },
  }))));
  Object.defineProperty(button, "value", { get: () => current, set: (v) => { current = String(v ?? ""); paint(); } });
  paint();
  return button;
}
function segmented(options, value, onChange) {
  const wrap = h("div", { class: "segmented", role: "group" });
  const paint = (v) => { for (const b of wrap.children) b.setAttribute("aria-pressed", String(b.dataset.v === v)); };
  for (const [v, l] of options) wrap.appendChild(h("button", { type: "button", dataset: { v }, onclick: () => { onChange(v); paint(v); } }, l));
  paint(value);
  return wrap;
}
function slider({ min, max, step, value, onInput, fmt = (v) => v, label }) {
  const out = h("span", { class: "muted", style: { minWidth: "44px", textAlign: "right", fontVariantNumeric: "tabular-nums" } }, fmt(value));
  const input = h("input", { type: "range", min, max, step, "aria-label": label });
  input.value = value;
  const paint = () => { input.style.setProperty("--pct", `${((input.value - min) / (max - min)) * 100}%`); out.textContent = fmt(Number(input.value)); };
  input.addEventListener("input", () => { paint(); onInput(Number(input.value)); });
  paint();
  return h("div", { style: { display: "flex", alignItems: "center", gap: "10px", width: "100%" } }, input, out);
}
function numberCtl(value, onChange, label) {
  const i = h("input", { class: "text-field", type: "number", inputmode: "numeric", "aria-label": label });
  i.value = value;
  i.addEventListener("change", () => onChange(Number(i.value)));
  return i;
}
const section = (id, title, rows) => h("section", { class: "sec", dataset: { id } }, h("h2", null, title), h("div", { class: "card" }, rows));

// ---- sections -------------------------------------------------------------------------------------------------
function appearance(rerender) {
  const s = settingsStore.get();
  const rows = [
    row({ label: "主题", ctl: segmented([["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"], ["oled", "OLED 纯黑"]], s.theme, (v) => { saveSettings({ theme: v }); applyTheme(); rerender(); }), keywords: "深色 浅色 黑 dark light oled black" }),
  ];
  if (s.theme !== "oled") {
    rows.push(row({ label: "主题色", desc: "浅色 / 深色模式用它作为强调色", stack: true, keywords: "颜色 色相 color hue material you",
      ctl: h("div", { style: { display: "flex", gap: "12px", alignItems: "center", width: "100%" } }, h("span", { class: "hue-swatch" }),
        slider({ min: 0, max: 360, step: 1, value: s.hue, label: "主题色色相", onInput: (v) => { saveSettings({ hue: v }); applyTheme(); }, fmt: (v) => `${v}°` })) }));
  }
  rows.push(row({ label: "密度", ctl: segmented([["compact", "紧凑"], ["comfortable", "舒适"]], s.density, (v) => { saveSettings({ density: v }); applyTheme(); }) }));
  return section("appearance", "外观", rows);
}

function editorSection() {
  const s = settingsStore.get();
  return section("editor", "编辑器", [
    row({ label: "字号", stack: true, ctl: slider({ min: 10, max: 22, step: 1, value: s.fontSize, label: "字号", onInput: (v) => { saveSettings({ fontSize: v }); applyTheme(); }, fmt: (v) => `${v}px` }) }),
    row({ label: "CodeMirror 6", desc: "代码折叠、语言高亮与补全", keywords: "codemirror cm6 内核 折叠 补全" }),
    row({ label: "跟随 AI 编辑", desc: "AI 创建或修改文件时，自动打开对应文件并定位到修改位置。", ctl: switchCtl(s.followAgentEdits !== false, (v) => saveSettings({ followAgentEdits: v }), "跟随 AI 编辑"), keywords: "AI 智能体 自动打开 定位 动画 follow agent edit" }),
    row({ label: "显示隐藏文件", desc: "在文件树里显示 .git、.DS_Store 等默认隐藏项；不会改变搜索范围。", ctl: switchCtl(s.showHiddenFiles, (v) => saveSettings({ showHiddenFiles: v }), "显示隐藏文件"), keywords: "隐藏文件 .git hidden files" }),
    row({ label: "缩进宽度", ctl: selectCtl([["2", "2 个空格"], ["4", "4 个空格"], ["8", "8 个空格"]], String(s.tabWidth), (v) => { saveSettings({ tabWidth: Number(v) }); applyTheme(); }, "缩进宽度") }),
    row({ label: "代码符号栏按键", desc: "用英文逗号分隔，显示在手机键盘上方", stack: true, keywords: "键盘 符号 keyboard symbols",
      ctl: (() => { const i = h("input", { class: "text-field", type: "text", "aria-label": "符号栏按键", autocapitalize: "off" }); i.value = s.toolbar.join(","); i.addEventListener("change", () => saveSettings({ toolbar: i.value.split(",").map((x) => x.trim()).filter(Boolean) })); return i; })() }),
  ]);
}

function providers(rerender) {
  const st = state.get();
  const rows = st.profiles.map((p) => h("button", { class: "row-btn", type: "button", dataset: { search: search(p.name, p.model, p.kind) }, onclick: () => editProfile(p, rerender) },
    icon("spark", 20), h("span", { style: { flex: 1, minWidth: 0 } }, p.name, h("small", { class: "muted", style: { display: "block" } }, `${p.kind || "provider"} · ${String(p.model ?? p.id ?? "未命名模型")}`)),
    h("span", { class: "pill " + (p.has_key ? "" : "warn") }, p.has_key ? "已保存密钥" : "没有密钥")));
  rows.push(btnRow("添加服务商配置", "add", () => editProfile(null, rerender), "服务商 密钥 接口 模型 openai deepseek kimi ollama openrouter gemini minimax endpoint model api key"));
  return section("providers", "AI 模型服务商", rows);
}

function editProfile(p, rerender) {
  const presets = state.get().hello?.presets || {};
  const kinds = Object.keys(presets).filter((k) => !presets[k].not_yet);
  const KIND_ZH = { openai: "OpenAI", deepseek: "DeepSeek", kimi: "Kimi（月之暗面）", openrouter: "OpenRouter", gemini: "Gemini（OpenAI 兼容端点）", gemini_native: "Gemini（原生接口）", anthropic: "Anthropic Claude（原生接口）", ollama: "Ollama（本地模型）", minimax: "MiniMax（国际站）", minimax_cn: "MiniMax（中国大陆站）", openai_compatible: "自定义 OpenAI 兼容接口" };
  const f = {
    name: h("input", { class: "text-field", value: p?.name || "", placeholder: "例如：DeepSeek 写代码", autocapitalize: "off" }),
    kind: selectCtl(kinds.map((k) => [k, KIND_ZH[k] || k]), p?.kind || "openai_compatible", (v) => { if (!p) { f.endpoint.value = presets[v]?.endpoint || ""; f.model.value = presets[v]?.model || ""; } }, "服务商类型"),
    endpoint: h("input", { class: "text-field", value: p?.endpoint || "", placeholder: "https://…/v1", autocapitalize: "off", inputmode: "url" }),
    model: h("input", { class: "text-field", value: p?.model || "", placeholder: "模型名称", autocapitalize: "off" }),
    key: h("input", { class: "text-field", type: "password", placeholder: p?.has_key ? `已保存在${runtime.kind === "native" ? "本机" : "桥接服务"}（留空则保持不变）` : "API 密钥", autocomplete: "off" }),
    headers: h("input", { class: "text-field", value: p?.headers ? JSON.stringify(p.headers) : "", placeholder: '{"X-Custom": "value"}', autocapitalize: "off" }),
  };
  if (!p) { const k = f.kind.value; f.endpoint.value = presets[k]?.endpoint || ""; f.model.value = presets[k]?.model || ""; }
  const tools = switchCtl(p?.tool_calling ?? true, () => {}, "工具调用");
  const modelPick = h("button", { class: "btn tonal model-fetch", type: "button", onclick: async () => {
    let headers = {};
    if (f.headers.value.trim()) {
      try { headers = JSON.parse(f.headers.value); } catch { toast("请求头必须是有效的 JSON"); return; }
    }
    const old = modelPick.textContent;
    modelPick.disabled = true; modelPick.textContent = "获取中…";
    try {
      const r = await runtime.profiles.models({
        id: p?.id || null,
        api_key: f.key.value || undefined,
        profile: { kind: f.kind.value, endpoint: f.endpoint.value.trim(), headers },
      });
      const models = r.models || [];
      if (!models.length) { toast("服务商没有返回可选择的模型"); return; }
      openMenu(`选择模型（${models.length}）`, models.map((m) => ({ label: m, icon: "spark", onClick: () => { f.model.value = m; } })));
    } catch (e) { toast(`获取模型失败：${e?.message || String(e || "未知错误")}`); }
    finally { modelPick.disabled = false; modelPick.textContent = old; }
  } }, "自动获取");
  const modelCtl = h("div", { class: "model-field" }, f.model, modelPick);
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "profile";
  const field = (label, el) => h("label", { class: "field" }, label, el);
  const body = h("div", { style: { display: "grid", gap: "12px", paddingBottom: "8px" } },
    field("名称", f.name), field("服务商类型", f.kind), field("接口地址", f.endpoint), field("模型 ID", modelCtl), field("API 密钥", f.key),
    h("p", { class: "muted", style: { fontSize: "12px" } }, runtime.kind === "native" ? "密钥只保存在本机 Native Core 的数据目录中，这个页面拿不回来。" : "密钥只保存在运行桥接服务的那台电脑上，这个页面拿不回来。"),
    field("自定义请求头（JSON，可选）", f.headers), h("div", { class: "srow", style: { padding: "0" } }, h("div", { class: "lbl" }, "工具调用"), tools),
    h("p", { class: "muted", style: { fontSize: "12px" } }, "Anthropic 和 Gemini 都有原生适配器。其他模型请选「自定义 OpenAI 兼容接口」，填上接口地址即可。"));
  const sheet = openSheet({
    title: p ? "编辑服务商" : "新建服务商", tall: true, body,
    footer: [
      p ? h("button", { class: "btn text danger", type: "button", onclick: async () => { await runtime.profiles.delete({ id: p.id }); sheet.close(); rerender(); } }, "删除") : null,
      h("button", { class: "btn tonal", type: "button", onclick: async (e) => {
        try { const id = await save(); e.target.textContent = "测试中…"; const r = await runtime.profiles.test({ id }); toast(`连接成功：“${r.reply.trim() || "ok"}”`); } catch (err) { toast(err.message); }
        e.target.textContent = "保存并测试";
      } }, "保存并测试"),
      h("button", { class: "btn filled", type: "button", onclick: async () => { try { await save(); sheet.close(); rerender(); } catch (err) { toast(err.message); } } }, "保存"),
    ],
  });
  async function save() {
    if (!f.name.value.trim()) throw new Error("请给这个配置起个名字");
    let headers = {};
    if (f.headers.value.trim()) { try { headers = JSON.parse(f.headers.value); } catch { throw new Error("请求头必须是有效的 JSON"); } }
    const id = p?.id || slug(f.name.value);
    const profile = { id, name: f.name.value.trim(), kind: f.kind.value, endpoint: f.endpoint.value.trim(), model: f.model.value.trim(), headers, tool_calling: tools.querySelector("input").checked };
    const saved = await runtime.profiles.save({ profile, api_key: f.key.value ? f.key.value : undefined });
    if (!settingsStore.get().agent.profile) saveSettings({ agent: { profile: saved.id } });
    f.key.value = "";
    return id;
  }
}

function instructionRows(draft) {
  const ta = h("textarea", { class: "text-field", rows: "5", placeholder: "例如：永远用中文回答；提交说明用中文；不要改动 vendor/ 目录", "aria-label": "全局指令", style: { fontFamily: "var(--font-code)" } });
  const hint = h("small", null, "");
  ta.value = draft.value;
  const capture = () => { draft.edited = true; draft.value = ta.value; };
  ta.addEventListener("input", capture);
  const online = state.get().conn === "online";
  if (online) {
    hint.textContent = "正在读取项目指令…";
    runtime.instructions.get().then((r) => {
      if (!draft.edited) ta.value = draft.value = r.global;
      hint.textContent = r.project_exists ? `已找到项目根目录的 AGENTS.md（${r.project.length} 字），智能体每次任务都会优先阅读。` : "项目根目录还没有 AGENTS.md：新建一个，就能写下这个项目的架构、规范、构建命令和禁止改动的区域。";
    }).catch((error) => { hint.textContent = `读取指令失败：${error.message || "请重新打开设置"}`; });
    ta.addEventListener("change", () => { capture(); runtime.instructions.set({ global: ta.value }).then(() => toast("全局指令已保存")).catch((e) => toast(e.message)); });
  } else { ta.disabled = true; hint.textContent = "连接运行环境后可编辑指令"; }
  return [
    h("div", { class: "srow stack", dataset: { search: search("全局指令 每次任务 提示 instructions") } }, h("div", { class: "lbl" }, "全局指令", h("small", null, "对所有项目、所有任务都生效，修改后自动保存")), ta),
    h("div", { class: "srow", dataset: { search: search("项目指令 AGENTS.md") } }, h("div", { class: "lbl" }, "项目指令（AGENTS.md）", hint)),
  ];
}

function agentSection(instructionDraft) {
  const s = settingsStore.get(), lim = s.agent.limits;
  return section("agent", "智能体", [
    row({ label: "默认模式", desc: "聊天：只对话 · 只读：可以查看项目 · 编辑：可以修改文件 · 智能体：还能运行命令", ctl: segmented([["chat", "聊天"], ["read", "只读"], ["edit", "编辑"], ["agent", "智能体"]], s.agent.mode, (v) => saveSettings({ agent: { mode: v } })) }),
    row({ label: "思考模式", desc: "自动：遵循模型默认 · 开启/关闭：向支持的服务商发送对应思考参数；不支持完全关闭的模型会降到最低思考量", ctl: segmented([["auto", "自动"], ["on", "开启"], ["off", "关闭"]], s.agent.reasoning || "auto", (v) => saveSettings({ agent: { reasoning: v } })), keywords: "思考 reasoning thinking" }),
    row({ label: "工具调用上限", desc: "单个任务的硬性上限；0 表示不限次数，仍然可以随时手动停止任务", ctl: numberCtl(lim.max_tool_calls, (v) => saveSettings({ agent: { limits: { max_tool_calls: Math.max(0, v) } } }), "工具调用上限，0 表示不限"), keywords: "限制 上限 无限 limit unlimited" }),
    row({ label: "最大修复次数", desc: "构建或测试失败多少次后智能体放弃", ctl: numberCtl(lim.max_repair_attempts, (v) => saveSettings({ agent: { limits: { max_repair_attempts: v } } }), "最大修复次数"), keywords: "限制 循环 limit loop" }),
    row({ label: "最长运行时间（秒）", desc: "0 表示不限时；仍然可以随时手动停止任务", ctl: numberCtl(lim.max_seconds, (v) => saveSettings({ agent: { limits: { max_seconds: Math.max(0, v) } } }), "最长秒数，0 表示不限"), keywords: "限制 超时 无限 limit timeout unlimited" }),
    ...instructionRows(instructionDraft),
  ]);
}

const TOOL_ZH = { fs_read: "读取文件", fs_list: "列出目录", fs_search: "搜索文本", fs_glob: "按名称查找文件", fs_multi_read: "批量读取文件", fs_patch: "精确修改文件", fs_write: "新建或覆盖文件", fs_delete: "删除（先进回收站）", fs_rename: "重命名或移动", shell_run: "运行 shell 命令", terminal_read: "读取终端输出", ask_user: "向你提问", web_fetch: "访问网页" };
const CLASS_ZH = { read: "读取", write: "写入", delete: "删除", exec: "执行命令", network: "联网", interaction: "用户交互" };
const RISK_ZH = { low: "低风险", medium: "中风险", high: "高风险" };
function permissionsSection() {
  const st = state.get(), perm = st.permissions;
  if (!perm) return section("permissions", "工具与权限", [row({ label: "连接桥接服务后才能配置权限", desc: "权限由桥接服务执行，而不是由浏览器执行。" })]);
  const set = (patch) => runtime.permissions.set(patch).catch((e) => toast(e.message));
  const rows = [
    row({ label: "权限模式", desc: "严格：凡是有风险的都询问 · 手动：按你设定的规则询问 · AI 审批：由审批模型来判断 · 自主：大多数操作直接执行", stack: true,
      ctl: segmented([["restricted", "严格"], ["manual", "手动"], ["ai", "AI 审批"], ["autonomous", "自主"]], perm.mode, (v) => set({ mode: v })), keywords: "审批 自主 approval autonomous" }),
    row({ label: "审批模型", desc: "在「AI 审批」模式下，由哪个模型来审查工具调用", keywords: "审批 reviewer",
      ctl: selectCtl([["", "跟随主模型"], ...st.profiles.map((p) => [p.id, p.name])], st.hello?.approval_profile || "", (v) => set({ approval_profile: v }), "审批模型") }),
    row({ label: "安全规则永远优先", desc: "工作区之外的删除、修改正在运行的桥接服务、读取凭据、危险的 shell 命令，都由固定规则把关。智能体、审批模型、「始终允许」都绕不过它。", keywords: "安全 规则 hard policy" }),
  ];
  rows.push(btnRow("路径与命令规则…", "shield", () => openRulesSheet(perm), "规则 通配符 允许 禁止 路径 命令 glob rule"));
  const opts = [["", "默认"], ["deny", "禁止"], ["ask", "每次询问"], ["session", "本次会话允许"], ["always", "始终允许"], ["ai_review", "交给 AI 审批"]];
  for (const t of st.hello?.tools || []) {
    rows.push(row({ label: `${TOOL_ZH[t.id] || t.id}（${t.id}）`, desc: `${CLASS_ZH[t.permission_class] || t.permission_class} · ${RISK_ZH[t.risk] || t.risk}`, keywords: "工具 tool " + t.id + " " + t.permission_class,
      ctl: selectCtl(opts, perm.tool_settings?.[t.id] || "", (v) => set({ tool_settings: { [t.id]: v || null } }), t.id) }));
  }
  return section("permissions", "工具与权限", rows);
}

const KIND_ZH = { move: "移动", delete: "消失", insert: "出现", transform: "变形", groupMove: "整块移动" };
function openRulesSheet(perm) {
  const tools = state.get().hello?.tools || [];
  const inputs = {};
  const body = h("div", { style: { display: "grid", gap: "14px", paddingBottom: "8px" } },
    h("p", { class: "muted", style: { fontSize: "13px" } }, "每项用英文逗号分隔通配符。文件类工具匹配项目内的相对路径（例如 src/*、secrets/*），shell 工具匹配整条命令（例如 npm test*）。命中「禁止」一律拒绝；命中「自动允许」直接执行；安全规则永远优先，不会被这里放行。"),
    ...tools.filter((t) => t.id !== "terminal_read" && t.permission_class !== "interaction").map((t) => {
      const cur = perm.tool_rules?.[t.id] || { allow: [], deny: [] };
      const a = h("input", { class: "text-field", value: cur.allow.join(", "), placeholder: "自动允许", autocapitalize: "off", "aria-label": `${t.id} 自动允许` });
      const d = h("input", { class: "text-field", value: cur.deny.join(", "), placeholder: "禁止", autocapitalize: "off", "aria-label": `${t.id} 禁止` });
      inputs[t.id] = [a, d];
      return h("div", { style: { display: "grid", gap: "6px" } }, h("strong", null, `${TOOL_ZH[t.id] || t.id}（${t.id}）`), a, d);
    }));
  const split = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const sheet = openSheet({ title: "路径与命令规则", tall: true, body, footer: [
    h("button", { class: "btn text", type: "button", onclick: () => sheet.close() }, "取消"),
    h("button", { class: "btn filled", type: "button", onclick: async () => {
      const rules = {};
      for (const [id, [a, d]] of Object.entries(inputs)) rules[id] = { allow: split(a.value), deny: split(d.value) };
      try { await runtime.permissions.set({ tool_rules: rules }); toast("规则已保存"); sheet.close(); } catch (e) { toast(e.message); }
    } }, "保存")] });
}

const SAMPLE_BEFORE = "def add(a, b):\n    return a - b\n\ndef greet(name):\n    print('hi', name)\n\nresult = add(1, 2)\n";
const SAMPLE_AFTER = "def greet(name):\n    print('hello,', name)\n\ndef add(a, b):\n    return a + b\n\ntotal = add(1, 2)\nprint(total)\n";

function animationSection(rerender) {
  const a = settingsStore.get().anim;
  const packs = listPacks().map((p) => [p.id, p.name]);
  const rows = [
    row({ label: "效果选择", desc: "由引擎选择，或为每种代码改动指定效果", ctl: segmented([["auto", "引擎自动"], ["manual", "手动"]], a.mode, (v) => { saveSettings({ anim: { mode: v } }); rerender(); }) }),
  ];
  if (a.mode === "auto") rows.push(row({ label: "动画包", ctl: selectCtl(packs, a.pack, (v) => saveSettings({ anim: { pack: v } }), "动画包"), keywords: "效果 动画 effect dissolve glitch ash minimal" }));
  else for (const k of KINDS) rows.push(row({ label: `${KIND_ZH[k] || k}的效果`, ctl: selectCtl(packs, a.manual[k], (v) => saveSettings({ anim: { manual: { [k]: v } } }), k), keywords: "手动 manual insert delete move transform" }));
  rows.push(
    row({ label: "速度", stack: true, ctl: slider({ min: 0.5, max: 2, step: 0.05, value: a.speed, label: "速度", onInput: (v) => saveSettings({ anim: { speed: v } }), fmt: (v) => `${v.toFixed(2)}×` }) }),
    row({ label: "强度", desc: "代码消散或成形时飘动的幅度", stack: true, ctl: slider({ min: 0, max: 2, step: 0.05, value: a.intensity, label: "强度", onInput: (v) => saveSettings({ anim: { intensity: v } }), fmt: (v) => `${Math.round(v * 100)}%` }) }),
    row({ label: "粒子密度", desc: "数值高时，消失和新增的内容会被拆成单个字符", stack: true, ctl: slider({ min: 0, max: 1, step: 0.05, value: a.density, label: "粒子密度", onInput: (v) => saveSettings({ anim: { density: v } }), fmt: (v) => `${Math.round(v * 100)}%` }) }),
    row({ label: "电影模式", desc: "更慢、更有层次的过渡", ctl: switchCtl(a.cinematic, (v) => saveSettings({ anim: { cinematic: v } }), "电影模式") }),
    row({ label: "减少动态效果", ctl: selectCtl([["system", "跟随系统"], ["on", "始终减少"], ["off", "从不减少"]], a.reduced, (v) => saveSettings({ anim: { reduced: v } }), "减少动态效果") }),
    row({ label: "AI 修改时播放动画", ctl: switchCtl(a.playFor.ai, (v) => saveSettings({ anim: { playFor: { ai: v } } }), "AI 修改时播放动画") }),
    row({ label: "撤销或恢复时播放动画", ctl: switchCtl(a.playFor.undo, (v) => saveSettings({ anim: { playFor: { undo: v } } }), "撤销时播放动画") }),
    btnRow("播放预览", "play", () => openReplay({ path: "demo.py", before: SAMPLE_BEFORE, after: SAMPLE_AFTER }), "演示 demo test"),
    btnRow("安装动画包（JSON）…", "add", () => {
      const ta = h("textarea", { class: "text-field", rows: "8", placeholder: '{"id":"my-pack","version":1,"delete":{...}}', style: { fontFamily: "var(--font-code)" }, autocapitalize: "off", spellcheck: "false" });
      openDialog({ title: "安装动画包", body: ta, actions: [{ label: "取消" }, { label: "安装", primary: true, onClick: () => { try { installPack(JSON.parse(ta.value)); toast("动画包已安装"); rerender(); } catch (e) { toast("已拒绝：" + e.message); } } }] });
    }, "自定义 custom"),
  );
  return section("animation", "动画", rows);
}

function feedbackSection(rerender) {
  const preferences = settingsStore.get().feedback || {};
  const haptics = runtime.kind === "native" && state.get().hello?.capabilities?.haptics === true;
  const change = (key, value) => { saveSettings({ feedback: { [key]: value } }); rerender(); };
  const rows = [];
  if (haptics) rows.push(row({ label: "关键操作触觉", desc: "面板吸附、危险确认、任务完成与恢复成功；遵循系统触觉设置",
    ctl: switchCtl(preferences.haptics, (value) => change("haptics", value), "关键操作触觉"), keywords: "触感 振动 震动 haptic feedback" }));
  rows.push(row({ label: "完成提示音", desc: "仅在前台任务完成或恢复成功时播放，默认关闭",
    ctl: switchCtl(preferences.sound, (value) => change("sound", value), "完成提示音"), keywords: "声音 音效 sound audio feedback" }));
  const preview = btnRow("体验完成反馈", "play", async () => {
    const result = await previewFeedback();
    if (!result.performed && !result.sound) toast("当前未播放反馈，请检查反馈开关、系统触觉和音量设置");
  }, "试听 触感 预览 preview feedback");
  preview.disabled = !(preferences.sound || (haptics && preferences.haptics));
  rows.push(preview);
  return section("feedback", "声音与触觉", rows);
}

function bridgeSection(rerender) {
  const st = state.get(), conn = st.conn;
  if (runtime.kind === "native") {
    return section("bridge", "本地运行环境", [
      row({ label: "本地运行", desc: `${st.hello?.platform || "本机"} · 项目由本机处理`, keywords: "状态 本地环境 native rust status" }),
    ]);
  }
  const host = h("input", { class: "text-field", placeholder: "192.168.1.20", autocapitalize: "off", inputmode: "url", "aria-label": "主机地址" });
  const port = h("input", { class: "text-field", placeholder: "8765", inputmode: "numeric", "aria-label": "端口", style: { width: "96px" } });
  const token = h("input", { class: "text-field", placeholder: "设备令牌（局域网）", autocapitalize: "off", type: "password", "aria-label": "设备令牌" });
  const code = h("input", { class: "text-field", placeholder: "6 位配对码", inputmode: "numeric", "aria-label": "配对码" });
  const devices = h("div");
  const target = () => ({ host: host.value.trim() || "127.0.0.1", port: Number(port.value) || 8765, token: token.value.trim() || undefined });

  async function loadDevices() {
    try {
      const r = await runtime.devices.list();
      clear(devices);
      if (!r.devices.length) devices.appendChild(h("div", { class: "srow muted" }, "还没有已配对的设备。"));
      for (const d of r.devices) devices.appendChild(h("div", { class: "srow" }, h("div", { class: "lbl" }, d.name, h("small", null, `到期：${new Date(d.expires * 1000).toLocaleDateString("zh-CN")}`)),
        h("button", { class: "btn text small danger", type: "button", onclick: async () => { await runtime.devices.revoke({ id: d.id }); loadDevices(); } }, "撤销")));
    } catch { clear(devices); devices.appendChild(h("div", { class: "srow muted" }, "已配对的设备要在运行桥接服务的电脑上管理。")); }
  }
  if (conn === "online") loadDevices();

  return section("bridge", "Python 桥接", [
    row({ label: conn === "online" ? "已连接" : conn === "connecting" ? "连接中…" : "未连接", desc: conn === "online" ? `${st.hello?.platform || ""} · 桥接服务 ${st.hello?.version || ""}${st.hello?.lan ? " · 局域网模式已开启" : ""}` : "网页模式：可以使用草稿本，但文件、终端和智能体需要桥接服务。", keywords: "状态 本地环境 status local environment" }),
    row({ label: "手动连接", stack: true, keywords: "主机 端口 令牌 host port token", ctl: h("div", { style: { display: "grid", gap: "8px", width: "100%" } },
      h("div", { style: { display: "flex", gap: "8px" } }, host, port), token,
      h("button", { class: "btn filled", type: "button", onclick: async () => { try { await connectManual(target()); toast("已连接"); rerender(); } catch (e) { toast(`连接失败：${e.message}`); } } }, "连接")) }),
    row({ label: "用手机操作电脑上的项目", desc: "先在电脑上运行：python bridge/main.py --lan（它会打印一个配对码），然后在上面填写电脑的地址和端口，再在下面输入配对码。", stack: true, keywords: "局域网 配对 跨设备 lan pair",
      ctl: h("div", { style: { display: "grid", gap: "8px", width: "100%" } }, code,
        h("button", { class: "btn tonal", type: "button", onclick: async () => {
          const t = target();
          try { const tok = await runtime.remote.pair(t, code.value.trim(), navigator.userAgent.includes("Android") ? "安卓手机" : "这台设备"); await connectManual({ ...t, token: tok }); toast("配对并连接成功"); rerender(); }
          catch (e) { toast(e.message); }
        } }, "配对这台设备")) }),
    btnRow("显示配对码和二维码（在这台电脑上）", "shield", async () => {
      try {
        const r = await runtime.devices.pairCode();
        const ip = r.addresses[0], url = ip ? `http://${ip}:${r.port}/#pair=${r.code}` : null;
        let qr = null;
        if (url) { try { qr = qrSvg(url, { scale: 5 }); } catch { qr = null; } }
        openDialog({ title: "扫码或输入配对码", body: h("div", { style: { display: "grid", gap: "10px", justifyItems: "center" } },
          qr ? h("div", { class: "qrbox" }, qr) : null,
          h("div", { class: "code", style: { fontSize: "28px", letterSpacing: "6px", textAlign: "center", width: "100%" } }, r.code),
          h("p", { class: "muted", style: { textAlign: "center" } }, url ? `用手机相机扫描二维码，会打开 ${url} 并自动完成配对，5 分钟内有效。` : `没有检测到局域网地址。请在另一台设备上手动填写这台电脑的地址、端口 ${r.port} 和这个配对码。`),
          r.addresses.length > 1 ? h("p", { class: "muted", style: { textAlign: "center" } }, "这台电脑的其他地址：" + r.addresses.slice(1).join("、")) : null), actions: [{ label: "完成", primary: true }] });
      } catch (e) { toast(e.message); }
    }, "局域网 配对码 二维码 扫码 lan pairing code qr"),
    h("div", { dataset: { search: "已配对设备 撤销 paired devices revoke lan" } }, devices),
  ]);
}

function workspaceSection(rerender) {
  const st = state.get();
  const rows = [];
  const recent = st.hello?.recent || [];
  rows.push(row({ label: st.workspace ? st.workspace.name : "还没有打开项目", desc: st.workspace ? st.workspace.roots.join(", ") : "请在开始页面打开一个文件夹。", keywords: "项目 文件夹 project folder" }));
  for (const r of recent.slice(0, 6)) {
    const label = typeof r === "string" ? r : (r?.name || r?.path || "Android 项目");
    const removeParams = typeof r === "string" ? { path: r } : { location: r };
    rows.push(h("div", { class: "recent-row", dataset: { search: search("最近项目 recent project", label) } },
      h("button", { class: "row-btn recent-open", type: "button", onclick: () => openWorkspace(r).then(() => toast("已打开")).catch((e) => toast(e.message)) }, icon("folder", 20), h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label)),
      iconButton("trash", "从最近项目移除", () => runtime.workspace.removeRecent(removeParams).then(() => { toast("已从最近项目移除"); rerender(); }).catch((e) => toast(e.message)))));
  }
  const trash = h("div", { dataset: { search: "回收站 恢复 已删除 trash restore deleted files" } }, h("div", { class: "srow muted", role: "status" }, "正在读取回收站…"));
  let trashBusy = false;
  const sameWorkspace = () => {
    const current = state.get().workspace;
    if (!current || JSON.stringify(current.location || current.roots) !== JSON.stringify(st.workspace?.location || st.workspace?.roots)) throw new Error("工作区已切换，请重新操作");
  };
  async function trashAction(operation) {
    if (trashBusy) return;
    trashBusy = true;
    try { sameWorkspace(); await operation(); }
    catch (error) { toast(error.message || "操作失败，请重试"); }
    finally { trashBusy = false; }
  }
  async function loadTrash() {
    try {
      const r = await runtime.trash.list();
      clear(trash);
      trash.appendChild(h("div", { class: "srow" }, h("div", { class: "lbl" }, "Koide 回收站", h("small", null, `共 ${r.items.length} 项。无论是你还是 AI 删除的文件，都会先放到这里。`)),
        r.items.length ? h("button", { class: "btn text small danger", type: "button", onclick: () => trashAction(async () => { if (await confirmDialog({ title: "清空回收站？", message: "此操作无法撤销。", confirmLabel: "清空", danger: true })) { sameWorkspace(); await runtime.trash.empty(); await loadTrash(); } }) }, "清空") : null));
      for (const it of r.items.slice(0, 30)) trash.appendChild(h("div", { class: "srow" }, h("div", { class: "lbl", style: { overflow: "hidden" } }, it.original.split("/").pop(), h("small", null, it.original)),
        h("button", { class: "btn text small", type: "button", onclick: () => trashAction(async () => { await runtime.trash.restore({ id: it.id }); void emitFeedback("restore"); toast("已恢复"); await loadTrash(); }) }, "恢复"),
        h("button", { class: "btn text small danger", type: "button", onclick: () => trashAction(async () => {
          if (!(await confirmDialog({ title: "永久删除？", message: it.original, confirmLabel: "永久删除", danger: true }))) return;
          sameWorkspace(); await runtime.trash.delete({ id: it.id }); await loadTrash();
        }) }, "永久删除")));
    } catch (error) {
      clear(trash);
      trash.append(h("div", { class: "srow muted", role: "status" }, `回收站读取失败：${error.message || "请重试"}`), btnRow("重新读取回收站", "undo", loadTrash));
    }
  }
  if (st.workspace) { rows.push(trash); loadTrash(); rows.push(btnRow("关闭项目", "close", async () => { await runtime.workspace.close(); rerender(); }, "离开 leave")); }
  return section("workspace", "工作区", rows);
}

function privacySection() {
  const s = settingsStore.get();
  return section("privacy", "隐私", [
    row({ label: "你的数据在哪里", desc: runtime.kind === "native" ? "项目留在你选择的位置；设置、检查点和 API 密钥由本机 Native Core 管理。只有提示词，以及智能体主动读取的代码，才会发送给你配置的 AI 服务商。" : "项目、检查点和 API 密钥都留在运行桥接服务的那台电脑上。只有提示词，以及智能体主动读取的代码，才会发送给你配置的 AI 服务商。" }),
    row({ label: "开发者模式", desc: "显示更多调试信息；工具调用仍只显示人类可读字段，不暴露原始 JSON 参数", ctl: switchCtl(s.devMode, (v) => saveSettings({ devMode: v }), "开发者模式"), keywords: "调试 debug json" }),
  ]);
}

function advancedSection(rerender) {
  return section("advanced", "高级", [
    btnRow("导出设置（JSON）", "file", () => {
      const a = h("a", { href: URL.createObjectURL(new Blob([exportSettings()], { type: "application/json" })), download: "koide-settings.json" });
      document.body.appendChild(a); a.click(); a.remove();
    }, "备份 backup"),
    btnRow("导入设置（JSON）…", "add", () => {
      const ta = h("textarea", { class: "text-field", rows: "8", placeholder: "粘贴导出的设置 JSON", style: { fontFamily: "var(--font-code)" }, spellcheck: "false" });
      openDialog({ title: "导入设置", body: ta, actions: [{ label: "取消" }, { label: "导入", primary: true, onClick: () => { try { importSettings(ta.value); applyTheme(); rerender(); toast("设置已导入"); } catch (e) { toast("设置无效：" + e.message); } } }] });
    }, "恢复 restore"),
    btnRow("重置所有设置", "undo", async () => { if (await confirmDialog({ title: "重置设置？", message: "界面与反馈偏好会恢复默认值；已保存的模型服务商配置会保留。", confirmLabel: "重置", danger: true })) { resetSettings(); applyTheme(); rerender(); } }, "默认 default"),
    (() => {
      const version = String(state.get().hello?.version || "").trim();
      const label = runtime.kind === "native" ? `Koide${version ? " " + version : ""} Native` : `Koide${version ? " " + version : ""} Web`;
      return row({ label, keywords: "版本 关于 version about" });
    })(),
  ]);
}

// ---- page -----------------------------------------------------------------------------------------------------------
let activeSettings = null;
export function openSettings(jumpTo = null) {
  if (activeSettings) { activeSettings.navigate(jumpTo); return activeSettings; }
  const body = h("div", { class: "page-body" });
  const q = h("input", { class: "text-field", type: "search", placeholder: "搜索设置", "aria-label": "搜索设置" });
  const page = h("div", { class: "page", role: "dialog", "aria-label": "设置" },
    h("div", { class: "page-head settings-head" }, iconButton("back", "返回", () => request()), h("h1", null, "设置")),
    h("div", { class: "search-box" }, icon("search", 20), q), body);
  const empty = h("div", { class: "settings-empty", role: "status", hidden: true },
    h("p", null, "没有匹配的设置"), h("button", { class: "btn text", type: "button", onclick: () => { q.value = ""; filter(); q.focus(); } }, "清除搜索"));
  let closed = false, jumpTimer;
  document.body.appendChild(page);
  const enter = requestAnimationFrame(() => { if (!closed) page.classList.add("in"); });
  const request = pushLayer(() => {
    if (closed) return;
    closed = true; unsub(); cancelAnimationFrame(enter); clearTimeout(jumpTimer);
    page.inert = true; page.classList.remove("in");
    if (activeSettings?.el === page) activeSettings = null;
    setTimeout(() => page.remove(), reducedMotion() ? 0 : 360);
  });

  const instructionDraft = { value: "", edited: false };
  const builders = {
    appearance: () => appearance(() => render("appearance")), editor: editorSection,
    animation: () => animationSection(() => render("animation")), feedback: () => feedbackSection(() => render("feedback")),
    providers: () => providers(() => render("providers")), agent: () => agentSection(instructionDraft), permissions: permissionsSection,
    workspace: () => workspaceSection(() => render("workspace")), bridge: () => bridgeSection(() => render("bridge")),
    privacy: privacySection, advanced: () => advancedSection(render),
  };

  function render(id = null) {
    if (closed) return;
    const y = body.scrollTop;
    if (id && builders[id]) {
      const previous = body.querySelector(`[data-id="${id}"]`);
      if (previous) { previous.parentNode.insertBefore(builders[id](), previous); previous.remove(); }
    } else {
      clear(body);
      for (const [label, ids] of [["界面与编辑", ["appearance", "editor", "animation", "feedback"]], ["AI", ["providers", "agent", "permissions"]], ["项目与系统", ["workspace", "bridge", "privacy", "advanced"]]]) {
        body.appendChild(h("div", { class: "settings-group" }, h("div", { class: "settings-group-title" }, label), ids.map((key) => builders[key]())));
      }
      body.appendChild(empty);
    }
    body.scrollTop = y;
    filter();
  }
  function filter() {
    const term = q.value.trim().toLowerCase();
    for (const sec of body.querySelectorAll(".sec")) {
      let any = false;
      for (const r of sec.querySelectorAll(".card > *")) {
        const hit = !term || (r.dataset.search || "").includes(term) || sec.querySelector("h2").textContent.toLowerCase().includes(term);
        r.hidden = !hit;
        if (hit) any = true;
      }
      sec.hidden = !any;
    }
    for (const group of body.querySelectorAll(".settings-group")) group.hidden = ![...group.querySelectorAll(".sec")].some((sec) => !sec.hidden);
    empty.hidden = [...body.querySelectorAll(".sec")].some((sec) => !sec.hidden);
  }
  q.addEventListener("input", filter);
  const signature = (s) => JSON.stringify([s.conn, s.profiles, s.workspace, s.permissions, s.hello?.version, s.hello?.capabilities, s.hello?.recent]);
  const instructionContext = (s) => JSON.stringify([s.conn, s.workspace?.location || s.workspace?.roots]);
  let last = signature(state.get());
  let lastContext = instructionContext(state.get());
  const unsub = state.subscribe((s) => {
    const next = signature(s);
    if (next === last) return;
    last = next;
    const context = instructionContext(s);
    if (context !== lastContext) { lastContext = context; render("agent"); }
    // 运行状态只刷新相关区域；切换连接或项目时保留指令草稿。
    for (const id of ["providers", "permissions", "workspace", "bridge", "feedback", "advanced"]) render(id);
  });
  function navigate(id) {
    clearTimeout(jumpTimer);
    if (!id) { q.focus(); return; }
    q.value = ""; filter();
    const target = [...body.querySelectorAll(".sec")].find((sec) => sec.dataset.id === id);
    if (target) jumpTimer = setTimeout(() => { if (!closed) target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }); }, reducedMotion() ? 0 : 380);
  }
  render();
  if (jumpTo) navigate(jumpTo);
  activeSettings = { close: request, el: page, navigate };
  return activeSettings;
}
