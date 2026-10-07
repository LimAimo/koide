// Start screen. Adapts to state: no Bridge -> how to start one (and a scratch pad / demo still work as plain web),
// Bridge connected -> recent projects + open folder, no provider -> provider setup.

import { h, icon, iconButton, clear, toast } from "./dom.js";
import { openSheet, openMenu } from "./overlays.js";
import { runtime, state, openWorkspace, initConnection, openScratch, demoDiffusion } from "../services/app.js";
import { importDirectoryAsWorkspace } from "./transfer.js";

export function openFolderPicker() {
  const list = h("div", { class: "menu" });
  const crumbs = h("div", { class: "crumbs" });
  let current = null;
  const openBtn = h("button", { class: "btn filled", type: "button", onclick: async () => {
    try { await openWorkspace(current); sheet.close(); } catch (e) { toast(e.message); }
  } }, "打开这个文件夹");
  const isAndroidNative = runtime.kind === "native" && state.get().hello?.platform === "android";
  const safBtn = isAndroidNative ? h("button", {
    class: "btn filled",
    type: "button",
    onclick: async () => {
      try {
        await openWorkspace({ kind: "saf", pick: true });
        sheet.close();
      } catch (e) { toast(e.message); }
    },
  }, icon("folder", 18), "从手机选择项目文件夹") : null;
  const importBtn = isAndroidNative ? h("button", {
    class: "btn tonal",
    type: "button",
    onclick: async () => {
      sheet.close();
      try { await importDirectoryAsWorkspace(); }
      catch (e) { toast(`导入文件夹失败：${e?.message || String(e)}`); }
    },
  }, icon("upload", 18), "导入到 Koide 私有工作区") : null;
  const hint = isAndroidNative
    ? h("p", { class: "muted", style: { margin: "0 0 10px" } }, "推荐直接选择原项目文件夹：Koide 会通过 Android 系统目录授权原地读写，并记住授权。SAF 项目不提供 Git 和以项目目录为 cwd 的终端；需要这些能力时可复制到私有工作区。")
    : null;
  const mobileActions = isAndroidNative ? h("div", { class: "workspace-source-actions" }, safBtn, importBtn) : null;
  const sheet = openSheet({ title: "打开文件夹", tall: true, body: h("div", null, hint, mobileActions, crumbs, list), footer: [h("button", { class: "btn text", type: "button", onclick: () => sheet.close() }, "取消"), openBtn] });

  async function go(path) {
    try {
      const r = await runtime.workspace.browse({ path });
      current = r.virtual ? null : r.path;
      openBtn.disabled = !!r.virtual;
      crumbs.textContent = r.path + (r.is_project ? "   ✓ 看起来是个项目" : "");
      clear(list);
      if (r.parent) list.appendChild(h("button", { class: "menu-item", type: "button", onclick: () => go(r.parent) }, icon("back", 20), h("span", null, r.parent === "__locations__" ? "返回位置 / 盘符" : "返回上一级")));
      const entries = r.entries || (r.dirs || []).map((name) => ({ name, path: r.path.replace(/[\\\/]$/, "") + "/" + name }));
      for (const d of entries) list.appendChild(h("button", { class: "menu-item", type: "button", onclick: () => go(d.path) }, icon("folder", 20), h("span", null, d.name)));
      if (!entries.length) list.appendChild(h("div", { class: "muted", style: { padding: "12px" } }, r.virtual ? "没有发现可访问的位置。" : "这里没有子文件夹。"));
    } catch (e) { toast(e.message); }
  }
  go(null);
  return sheet;
}

export function createWelcome({ onOpenSettings }) {
  const inner = h("div", { class: "welcome-in" });
  const el = h("div", { class: "welcome" }, inner);

  function card(title, ...kids) { return h("div", { class: "wcard" }, h("h3", null, title), ...kids); }

  function render() {
    const s = state.get();
    const native = runtime.kind === "native";
    clear(inner);
    inner.append(h("div", null, h("h1", null, "Koide ", h("b", null, "IDE")), h("p", { class: "lead" }, "AI 工作时，看着你的代码自己重新组织。所有数据都留在你的设备上。")));

    if (s.conn !== "online") {
      inner.append(card("连接本地环境",
        h("p", { class: "muted" }, native ? (s.conn === "connecting" ? "正在连接本地环境…" : "本地环境尚未连接。请重试，或重新启动 Koide。") : (s.conn === "connecting" ? "正在查找桥接服务…" : "当前是网页模式：可以使用草稿本，但打开项目、终端和智能体需要 Python 桥接服务。")),
        h("div", { class: "code" }, native ? "本地应用直接运行，无需启动桥接服务。" : "安卓（Termux）：bash start.sh\nWindows：       start.bat\n任意系统：      python bridge/main.py"),
        h("div", { class: "welcome-actions" },
          h("button", { class: "btn tonal", type: "button", onclick: () => initConnection().then((t) => toast(t ? "已连接" : native ? "本地环境连接失败" : "没有找到桥接服务")).catch((e) => toast(e.message)) }, "重试"),
          native ? null : h("button", { class: "btn outlined", type: "button", onclick: () => onOpenSettings("bridge") }, "手动连接…"))));
    } else {
      const recent = s.hello?.recent || [];
      const recentLabel = (entry) => typeof entry === "string" ? entry : (entry?.name || entry?.path || "Android 项目");
      const recentRemoveParams = (entry) => typeof entry === "string" ? { path: entry } : { location: entry };
      const recentList = recent.length ? h("div", { class: "recent" }, ...recent.slice(0, 6).map((entry) => {
        const label = recentLabel(entry);
        const more = iconButton("more", "项目操作", () => openMenu("最近项目", [
          { label: "打开", icon: "folder", onClick: () => openWorkspace(entry).catch((e) => toast(e.message)) },
          { label: "从最近项目移除", icon: "trash", danger: true, onClick: () => runtime.workspace.removeRecent(recentRemoveParams(entry)).then(() => toast("已从最近项目移除")).catch((e) => toast(e.message)) },
        ]));
        return h("div", { class: "recent-row" },
          h("button", { class: "recent-open", type: "button", onclick: () => openWorkspace(entry).catch((e) => toast(e.message)) }, icon("folder", 20), h("span", { class: "p" }, "\u200e" + label)), more);
      })) : h("p", { class: "muted" }, "还没有最近打开的项目。");
      inner.append(card("项目",
        h("button", { class: "btn filled", type: "button", onclick: () => openFolderPicker() }, icon("folder", 18), "打开文件夹"),
        recentList));
    }

    inner.append(card("模型服务商",
      s.profiles.length ? h("p", { class: "muted" }, `已有 ${s.profiles.length} 个配置可用。你的密钥只保存在${runtime.kind === "native" ? "这台设备的 Native Core" : "桥接服务"}里。`) : h("p", { class: "muted" }, s.conn === "online" ? "添加一个服务商（OpenAI、DeepSeek、Kimi、OpenRouter、Ollama，或任意兼容 OpenAI 的接口）即可开始。"
        : native ? "连接本地环境后才能配置服务商。" : "连接桥接服务之后才能配置服务商。"),
      h("button", { class: "btn tonal", type: "button", disabled: s.conn !== "online", onclick: () => onOpenSettings("providers") }, s.profiles.length ? "管理服务商" : "设置服务商")));

    inner.append(card("只想先看看？",
      h("p", { class: "muted" }, "不需要 AI，也不需要项目，就能看到 Koide 的动画效果。"),
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        h("button", { class: "btn tonal", type: "button", onclick: () => demoDiffusion() }, icon("play", 18), "播放演示"),
        h("button", { class: "btn outlined", type: "button", onclick: () => openScratch("") }, "打开草稿本"))));
  }

  let last = "";
  state.subscribe((s) => {
    const sig = s.conn + s.profiles.length + JSON.stringify(s.hello?.recent || []);
    if (sig !== last) { last = sig; render(); }
    el.hidden = !!s.workspace || s.tabs.length > 0;
  });
  render();
  el.hidden = !!state.get().workspace || state.get().tabs.length > 0;
  return el;
}

export function openLegacyTerminal() {
  const out = h("div", { class: "term-out", role: "log", "aria-live": "off" });
  const input = h("input", { class: "text-field", type: "text", placeholder: "在项目文件夹里运行命令", autocapitalize: "off", autocomplete: "off", spellcheck: "false", enterkeyhint: "go", "aria-label": "命令" });
  let runId = null;
  const btn = h("button", { class: "btn filled", type: "button" }, "运行");
  const print = (t) => { out.appendChild(document.createTextNode(t)); out.scrollTop = out.scrollHeight; };

  const offs = [
    runtime.on("terminal.start", (d) => { if (d.source === "user") { runId = d.id; btn.textContent = "停止"; print(`\n$ ${d.command}\n`); } }),
    runtime.on("terminal.output", (d) => { if (d.source === "user" && d.id === runId) print(d.data); }),
    runtime.on("terminal.exit", (d) => { if (d.source === "user" && d.id === runId) { print(`\n[退出码 ${d.exit_code}]\n`); runId = null; btn.textContent = "运行"; } }),
  ];
  async function run() {
    if (runId) return runtime.terminal.kill({ id: runId });
    const cmd = input.value.trim();
    if (!cmd) return;
    try { await runtime.terminal.run({ command: cmd }); input.value = ""; } catch (e) { toast(e.message); }
  }
  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  const sheet = openSheet({ title: "终端", tall: true, onClose: () => offs.forEach((f) => f()), body: h("div", null, out, h("div", { class: "term-in" }, input, btn)) });
  print(runtime.kind === "native" ? "命令由 Koide 本地运行环境执行。\n" : "命令通过桥接服务在你的项目文件夹里运行。\n不支持交互式程序，也不支持需要输入密码的命令。\n");
  setTimeout(() => input.focus(), 400);
  return sheet;
}
