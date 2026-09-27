// AI chat panel. Tool activity appears as compact cards ("Reading Main.java", "Running ./gradlew build");
// Tool details are always rendered as human-readable fields; raw JSON arguments are never exposed. Approvals are inline cards.

import { h, icon, iconButton, clear, toast } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { openSheet, confirmDialog } from "./overlays.js";
import { runtime, events, state, startAgent, stopAgent, respondApproval, setConversation } from "../services/app.js";
import { settingsStore, saveSettings } from "../services/store.js";

const MODES = [["chat", "聊天"], ["read", "只读"], ["edit", "编辑"], ["agent", "智能体"]];
const SUGGESTIONS = ["讲讲这个项目的结构", "找出构建失败的原因并修复", "给主要模块补上测试"];

export function createChat({ onNeedExpand, onOpenTimeline, onOpenProviders }) {
  const scroll = h("div", { class: "chat-scroll", role: "log", "aria-live": "polite" });
  const modeSeg = h("div", { class: "segmented mode-slider", role: "group", "aria-label": "智能体模式" });
  const profileChip = h("button", { class: "composer-model-pill", type: "button", "aria-label": "模型与思考设置" });
  const input = h("textarea", { rows: "1", placeholder: "告诉 AI 你想怎么改代码…", "aria-label": "给 AI 发消息", enterkeyhint: "send" });
  const goIcon = icon("send", 22, "ic go"), stopIcon = icon("stop", 22, "ic stop");
  const send = h("button", { class: "send", type: "button", "aria-label": "发送" }, goIcon, stopIcon);
  const historyBtn = iconButton("history", "对话历史", () => openConversations());
  const closeBtn = iconButton("close", "关闭 AI 面板", () => saveSettings({ aiVisible: false }), "ai-close");
  const head = h("div", { class: "ai-head" }, h("div", { class: "seg-wrap" }, modeSeg), historyBtn, closeBtn);
  const composerCard = h("div", { class: "composer-card" },
    input,
    h("div", { class: "composer-actions" }, profileChip, h("span", { class: "composer-spacer" }), send));
  const composer = h("div", { class: "composer" }, composerCard);
  const el = h("section", { class: "ai", "aria-label": "AI 助手" }, head, scroll, composer);

  // ---- helpers -------------------------------------------------------------------------------------------------
  let stick = true;
  scroll.addEventListener("scroll", () => { stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60; });
  const toBottom = () => { if (stick) scroll.scrollTop = scroll.scrollHeight; };
  const add = (node) => { dropEmpty(); scroll.appendChild(node); toBottom(); return node; };

  let emptyEl = null;
  function showEmpty() {
    if (scroll.children.length) return;
    emptyEl = h("div", { class: "chat-empty" }, h("h3", null, "想做点什么？"),
      h("p", null, "说出你的目标。AI 会自己读代码、改代码、跑测试；每一步你都能看见，也能随时停止或撤销。"),
      h("div", { class: "suggest" }, SUGGESTIONS.map((s) => h("button", { class: "btn tonal small", type: "button", onclick: () => { input.value = s; input.focus(); grow(); } }, s))));
    scroll.appendChild(emptyEl);
  }
  function dropEmpty() { if (emptyEl) { emptyEl.remove(); emptyEl = null; } }

  // ---- header ---------------------------------------------------------------------------------------------------
  let headSig = "";
  function paintHeader() {
    const s = settingsStore.get(), st = state.get();
    const sig = s.agent.mode + "|" + s.agent.profile + "|" + (s.agent.reasoning || "auto") + "|" + (s.agent.webSearch ? 1 : 0) + "|" + st.profiles.map((p) => p.id + p.name).join(",");
    if (sig === headSig) return;
    headSig = sig;
    if (!modeSeg.children.length) {
      // Built once: a sliding pill behind four fixed buttons. Tap-only (no drag) — the state is discrete
      // and a half-dragged gesture has no well-defined value, so dragging is intentionally not supported.
      const thumb = h("div", { class: "mode-thumb", "aria-hidden": "true" });
      modeSeg.appendChild(thumb);
      MODES.forEach(([id, label], i) => modeSeg.appendChild(h("button", { type: "button", "aria-pressed": "false", onclick: () => saveSettings({ agent: { mode: id } }) }, label)));
    }
    const idx = MODES.findIndex(([id]) => id === s.agent.mode);
    modeSeg.style.setProperty("--i", String(Math.max(0, idx)));
    modeSeg.style.setProperty("--n", String(MODES.length));
    const supported = Array.isArray(st.hello?.agent_modes) ? st.hello.agent_modes : MODES.map(([id]) => id);
    [...modeSeg.querySelectorAll("button")].forEach((b, i) => {
      const id = MODES[i][0];
      b.setAttribute("aria-pressed", String(i === idx));
      b.disabled = !supported.includes(id);
      b.title = supported.includes(id) ? "" : "Native Core 仍在迁移这个模式";
    });
    const prof = st.profiles.find((p) => p.id === s.agent.profile) || st.profiles[0];
    profileChip.hidden = !prof;
    clear(profileChip);
    if (prof) profileChip.append(icon("spark", 15), h("span", null, providerName(prof)));
    renderModelPopover();
  }

  // ---- model + thinking popover (a dropup anchored on the composer, not a modal) --------------------------------
  let popoverEl = null;
  const closePopover = () => { if (popoverEl) { popoverEl.remove(); popoverEl = null; document.removeEventListener?.("pointerdown", onOutsidePopover, true); } };
  function onOutsidePopover(e) { if (popoverEl && !popoverEl.contains(e.target) && !profileChip.contains(e.target)) closePopover(); }
  const cleanLabel = (value) => { const text = String(value ?? "").trim(); return /^(?:null|undefined)$/i.test(text) ? "" : text; };
  const providerName = (p) => cleanLabel(p?.name) || cleanLabel(p?.id) || "未命名服务商";
  const modelName = (p) => cleanLabel(p?.model) || cleanLabel(p?.model_id) || cleanLabel(p?.id) || "未命名模型";
  function switchCtl(on, onToggle) {
    return h("button", { class: "switch" + (on ? " on" : ""), type: "button", role: "switch", "aria-checked": String(on),
      onclick: (e) => { e.stopPropagation(); onToggle(); } }, h("span", { class: "switch-knob" }));
  }
  function renderModelPopover() {
    if (!popoverEl) return;
    const s = settingsStore.get(), st = state.get();
    const prof = st.profiles.find((p) => p.id === s.agent.profile) || st.profiles[0];
    const thinking = s.agent.reasoning || "auto";
    clear(popoverEl);
    const providerList = h("div", { class: "popover-list" }, ...st.profiles.map((p) => h("button", {
      class: "popover-item" + (prof && p.id === prof.id ? " active" : ""), type: "button",
      onclick: () => {
        saveSettings({ agent: { profile: p.id, ...(p.kind === "deepseek" ? {} : { webSearch: false }) } });
        closePopover();
      },
    }, icon("spark", 16), h("span", null, `${providerName(p)} · ${modelName(p)}`), p.has_key ? null : h("span", { class: "pill warn" }, "无密钥"))));
    const thinkingRow = h("div", { class: "popover-row" }, h("span", null, "思考"),
      switchCtl(thinking !== "off", () => { saveSettings({ agent: { reasoning: thinking === "off" ? "auto" : "off" } }); renderModelPopover(); }));
    popoverEl.append(providerList, h("div", { class: "popover-divider" }), thinkingRow);
    if (prof?.kind === "deepseek") popoverEl.append(h("div", { class: "popover-row" }, h("span", null, "联网搜索（DeepSeek）"),
      switchCtl(!!s.agent.webSearch, () => { saveSettings({ agent: { webSearch: !s.agent.webSearch } }); renderModelPopover(); })));
    popoverEl.append(
      h("button", { class: "popover-item", type: "button",
        disabled: runtime.kind === "native" && !(st.hello?.native_migration?.implemented || []).includes("conversation.compact"),
        title: runtime.kind === "native" && !(st.hello?.native_migration?.implemented || []).includes("conversation.compact") ? "Native Core 仍在迁移上下文压缩" : "",
        onclick: async () => {
        closePopover();
        const cid = state.get().conversationId;
        if (!cid) return toast("当前还没有可以压缩的对话");
        const ok = await confirmDialog({ title: "压缩这段对话？", message: "AI 会把目前为止的对话总结成一份摘要，用来代替原始记录继续后续任务；原文仍会保留在这里，只是会显示为灰色，之后的新任务不会再把原文发给模型。这个操作不能撤销。", confirmLabel: "压缩", danger: false });
        if (!ok) return;
        try {
          toast("正在压缩…");
          await runtime.conversations.compact({ conversation_id: cid, profile: prof && prof.id });
          await loadConversation(cid);
          toast("已压缩");
        } catch (e) { toast(e.message); }
      } }, icon("compress", 16), h("span", null, "压缩上下文")),
      h("button", { class: "popover-item", type: "button", onclick: () => { closePopover(); onOpenProviders(); } },
        icon("tune", 16), h("span", null, "服务商设置…")));
  }
  profileChip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popoverEl) return closePopover();
    popoverEl = h("div", { class: "popover model-popover", role: "menu", "aria-label": "模型与思考" });
    composer.appendChild(popoverEl);
    renderModelPopover();
    requestAnimationFrame(() => popoverEl && popoverEl.classList.add("in"));
    document.addEventListener("pointerdown", onOutsidePopover, true);
  });

  // ---- composer ---------------------------------------------------------------------------------------------------
  function grow() { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); go(); } });
  send.addEventListener("click", () => (state.get().agent.running ? stopAgent().catch((e) => toast(e.message)) : go()));

  async function go() {
    const text = input.value.trim();
    if (!text) return;
    if (state.get().conn !== "online") return toast(runtime.kind === "native" ? "本地 Native Core 尚未连接" : "请先连接桥接服务（设置 › Python 桥接）");
    if (!state.get().workspace) return toast("请先打开一个项目文件夹");
    try {
      await startAgent(text);
      stick = true;
      add(h("div", { class: "msg user" }, text));
      input.value = "";
      composer.classList.add("compact");
      grow();
    } catch (e) { toast(e.message); }
  }

  state.subscribe((s) => {
    const supported = Array.isArray(s.hello?.agent_modes) ? s.hello.agent_modes : null;
    const currentMode = settingsStore.get().agent.mode;
    if (runtime.kind === "native" && supported?.length && !supported.includes(currentMode)) {
      queueMicrotask(() => saveSettings({ agent: { mode: supported[0] } }));
    }
    send.classList.toggle("running", s.agent.running);
    send.setAttribute("aria-label", s.agent.running ? "停止" : "发送");
    paintHeader();
  });
  settingsStore.subscribe(paintHeader);

  // ---- streaming assistant text -------------------------------------------------------------------------------------
  let cur = null, curText = "", raf = 0;
  const renderCur = () => { raf = 0; if (!cur) return; clear(cur); cur.appendChild(renderMarkdown(curText)); toBottom(); };
  runtime.on("agent.message", (d) => {
    if (!cur) { cur = add(h("div", { class: "msg assistant" })); curText = ""; }
    curText += d.delta;
    if (!raf) raf = requestAnimationFrame(renderCur);
  });
  let reasoning = null, reasoningText = "";
  runtime.on("agent.reasoning", (d) => {
    if (!reasoning) {
      const body = h("div");
      reasoning = { body, el: add(h("details", { class: "msg reasoning", open: true }, h("summary", null, "思考过程"), body)) };
      reasoningText = "";
    }
    reasoningText += d.delta;
    reasoning.body.textContent = reasoningText;
  });
  // Flushes any pending animation frame so the last words of a reply are painted before something else
  // (a tool card, a question, `agent.done`) is inserted after it — but does NOT end the bubble: a model
  // can keep emitting reasoning (and occasionally text) around a tool call it is still forming, and that
  // must keep landing in the same bubble or a sentence visibly gets cut in half by the tool card.
  const flushPending = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; renderCur(); } };
  // Only a real turn boundary — the model's stream actually ending, or the task pausing/finishing — should
  // start a fresh bubble for whatever comes next.
  const endText = () => { flushPending(); cur = null; reasoning = null; };
  runtime.on("agent.turn_end", () => endText());

  // ---- tool cards ---------------------------------------------------------------------------------------------------
  const cards = new Map();
  const STATE_TEXT = { preparing: "准备中", pending: "", waiting: "等待中", running: "运行中", done: "", error: "失败", denied: "已拒绝" };

  function argRows(args = {}) {
    const rows = [];
    const kv = (k, v) => rows.push(h("div", { class: "kv" }, h("span", { class: "k" }, k), h("span", { class: "v" }, String(v))));
    if (args.path) kv("路径", args.path);
    if (args.from) kv("来源 → 目标", `${args.from} → ${args.to}`);
    if (args.command) kv("命令", args.command);
    if (args.query) kv("搜索内容", args.query);
    if (args.pattern) kv("匹配模式", args.pattern);
    if (args.url) kv("网址", args.url);
    if (Array.isArray(args.paths)) kv("文件", args.paths.length <= 6 ? args.paths.join("、") : `${args.paths.length} 个文件`);
    if (Array.isArray(args.edits)) kv("修改", `${args.edits.length} 处`);
    return rows;
  }

  function upsertCard(d) {
    let c = cards.get(d.call_id);
    if (!c && d.replace_call_id) {
      c = cards.get(d.replace_call_id);
      if (c) { cards.delete(d.replace_call_id); cards.set(d.call_id, c); }
    }
    if (!c) {
      flushPending();
      const chev = icon("chevron", 18, "chev"), title = h("span", { class: "t" }), sum = h("span", { class: "s" });
      const marks = h("span", { class: "ico", "aria-hidden": "true" }, h("span", { class: "spinner state-ico busy" }),
        icon("check", 18, "state-ico success"), icon("shield", 18, "state-ico waiting"), icon("warning", 18, "state-ico failure"));
      const headBtn = h("button", { class: "tool-head", type: "button", "aria-expanded": "false" }, marks, title, sum, chev);
      const inner = h("div", { class: "in" });
      const out = h("pre", { hidden: true });
      const card = h("div", { class: "tool", dataset: { state: "pending" } }, headBtn, h("div", { class: "tool-body" }, h("div", null, inner)));
      headBtn.addEventListener("click", () => { const o = card.classList.toggle("open"); headBtn.setAttribute("aria-expanded", String(o)); });
      inner.appendChild(out);
      c = { card, title, sum, headBtn, inner, out, args: null, chars: 0 };
      cards.set(d.call_id, c);
      add(card);
    }
    if (d.title) c.title.textContent = d.title;
    if (d.args && !c.args) {
      c.args = d.args;
      const rows = argRows(d.args);
      for (const r of rows.reverse()) c.inner.insertBefore(r, c.inner.firstChild);
    }
    c.card.dataset.state = d.state;
    c.sum.textContent = d.summary || STATE_TEXT[d.state] || "";
    if (d.detail) {
      let det = c.inner.querySelector(".detail");
      if (!det) { det = h("div", { class: "kv detail" }, h("span", { class: "k" }, "说明"), h("span", { class: "v" })); c.inner.insertBefore(det, c.out); }
      det.querySelector(".v").textContent = d.detail;
      if (d.state === "error" || d.state === "denied") { c.card.classList.add("open"); c.headBtn.setAttribute("aria-expanded", "true"); }
    }
  }
  runtime.on("agent.tool", upsertCard);
  runtime.on("terminal.output", (d) => {
    if (d.source !== "agent") return;
    const c = cards.get(d.call_id);
    if (!c || c.chars > 20000) return;
    c.chars += d.data.length;
    c.out.hidden = false;
    c.out.textContent += d.data;
    c.out.scrollTop = c.out.scrollHeight;
  });

  // ---- model questions --------------------------------------------------------------------------------------------------
  const questionEls = new Map();
  function addQuestion(q) {
    if (questionEls.has(q.question_id)) return;
    flushPending();
    const items = q.questions && q.questions.length ? q.questions : [{ question: q.question, options: q.options, allow_custom: q.allow_custom }];
    const multi = items.length > 1;
    const inputs = items.map(() => ({ picked: null }));
    const submitAll = async () => {
      const answers = items.map((_, i) => (inputs[i].picked ?? (rows[i].querySelector(".question-input")?.value ?? "")).trim());
      const missing = answers.findIndex((a) => !a);
      if (missing !== -1) return toast(multi ? `请回答第 ${missing + 1} 个问题` : "请输入或选择一个回答");
      if (submitBtn) submitBtn.disabled = true;
      rows.forEach((r) => r.querySelectorAll("button, input").forEach((x) => { x.disabled = true; }));
      try { await runtime.agent.answer({ question_id: q.question_id, answers }); }
      catch (e) { toast(e.message); if (submitBtn) submitBtn.disabled = false; rows.forEach((r) => r.querySelectorAll("button, input").forEach((x) => { x.disabled = false; })); }
    };
    const rows = items.map((it, i) => {
      const buttons = h("div", { class: "btns" }, ...(it.options || []).map((x) =>
        h("button", { class: "btn tonal small", type: "button", onclick: () => { inputs[i].picked = x; paintPicked(); if (!multi) submitAll(); else if (inp) inp.value = ""; } }, x)));
      const paintPicked = () => { for (const b of buttons.children) b.classList.toggle("active", b.textContent === inputs[i].picked); };
      let inp = null;
      if (it.allow_custom !== false) {
        inp = h("input", { class: "text-field question-input", type: "text", placeholder: multi ? "或输入你的回答…" : "输入你的回答…", "aria-label": `回答：${it.question}` });
        inp.addEventListener("input", () => { inputs[i].picked = null; for (const b of buttons.children) b.classList.remove("active"); });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { inputs[i].picked = inp.value.trim() || null; submitAll(); } });
      }
      return h("div", { class: "question-item" },
        h("div", { class: "question-text" }, multi ? `${i + 1}. ${it.question}` : it.question),
        buttons.children.length ? buttons : null, inp);
    });
    const submitBtn = multi ? h("button", { class: "btn filled small", type: "button", onclick: submitAll }, "回答") : null;
    const card = h("div", { class: "question-card", role: "group", "aria-label": "AI 正在向你提问" },
      h("h4", null, icon("spark", 18), multi ? `AI 需要你回答 ${items.length} 个问题` : "AI 需要你的选择"),
      ...rows, submitBtn);
    questionEls.set(q.question_id, card);
    add(card);
    onNeedExpand && onNeedExpand();
  }
  runtime.on("agent.question", addQuestion);
  runtime.on("agent.question_resolved", (d) => {
    const card = questionEls.get(d.question_id);
    if (card) { card.classList.add("done"); card.querySelectorAll("button, input").forEach((x) => { x.disabled = true; }); }
  });

  // ---- approvals ---------------------------------------------------------------------------------------------------------
  const approvalEls = new Map();
  function addApproval(a) {
    if (approvalEls.has(a.approval_id)) return;
    endText();
    const decide = (allow, scope) => respondApproval(a.approval_id, allow, scope).catch((e) => toast(e.message));
    const btns = h("div", { class: "btns" },
      h("button", { class: "btn filled small", type: "button", onclick: () => decide(true, "once") }, "允许一次"),
      a.forced ? null : h("button", { class: "btn tonal small", type: "button", onclick: () => decide(true, "session") }, "本次会话都允许"),
      h("button", { class: "btn text small danger", type: "button", onclick: () => decide(false) }, "拒绝"));
    const detail = a.args && (a.args.command || a.args.path || a.args.from) ? h("div", { class: "cmd" }, a.args.command || a.args.path || `${a.args.from} → ${a.args.to}`) : null;
    const card = h("div", { class: "approval", role: "alertdialog", "aria-label": "需要审批" },
      h("h4", null, icon("shield", 18), a.title, h("span", { class: "pill " + (a.forced ? "danger" : "warn") }, a.forced ? "安全规则" : ({ low: "低风险", medium: "中风险", high: "高风险" }[a.risk] || a.risk))),
      h("div", { class: "why" }, a.reason || "这个操作需要你的确认。"), detail, btns);
    approvalEls.set(a.approval_id, card);
    add(card);
    onNeedExpand && onNeedExpand();
  }
  runtime.on("approval.request", addApproval);
  runtime.on("approval.resolved", (d) => {
    const card = approvalEls.get(d.approval_id);
    if (card) { card.classList.add("done"); const b = card.querySelector(".btns"); if (b) b.remove(); }
  });
  runtime.on("hello", (hello) => { for (const a of hello.approvals || []) addApproval(a); for (const q of hello.questions || []) addQuestion(q); });

  // ---- lifecycle notes -----------------------------------------------------------------------------------------------------
  runtime.on("agent.started", (d) => { endText(); add(h("div", { class: "msg note" }, icon("spark", 14), "任务开始")); });
  runtime.on("agent.done", (d) => {
    endText();
    const label = { done: "任务完成", incomplete: "任务可能未完成", stopped: "任务已停止", error: "任务失败" }[d.status] || "任务结束";
    const showSummary = (d.status === "error" || d.status === "incomplete") && d.summary;
    const canContinue = d.status === "stopped" || d.status === "error" || d.status === "incomplete";
    add(h("div", { class: "msg note" + (d.status === "incomplete" ? " warn" : "") },
      label + (showSummary ? `：${d.summary}` : ""),
      h("button", { class: "btn text small", type: "button", onclick: () => onOpenTimeline(d.task_id) }, "查看改动"),
      canContinue ? h("button", { class: "btn tonal small", type: "button", onclick: () => startAgent("继续。").catch((e) => toast(e.message)) }, "继续") : null));
  });

  // ---- 对话历史：每个项目可以有多个对话，新任务会带着当前对话的上下文 -----------------------------------------------------------
  function resetChat() { clear(scroll); cards.clear(); approvalEls.clear(); questionEls.clear(); cur = null; reasoning = null; emptyEl = null; showEmpty(); }
  function renderEntries(entries) {
    resetChat();
    dropEmpty();
    for (const e of entries) {
      if (e.role === "compact") {
        // Everything appended so far predates this compaction point — the model no longer sees it
        // directly (only the summary that follows), so gray it out and draw a divider under it.
        [...scroll.children].forEach((n) => n.classList.add("pre-compact"));
        scroll.appendChild(h("div", { class: "compact-divider" }, h("span", null, "以上对话已压缩为摘要")));
        const m = h("div", { class: "msg assistant compact-summary" }); m.appendChild(renderMarkdown(e.text)); scroll.appendChild(m);
        continue;
      }
      if (e.role === "user") scroll.appendChild(h("div", { class: "msg user" }, e.text));
      else if (e.role === "assistant") { const m = h("div", { class: "msg assistant" }); m.appendChild(renderMarkdown(e.text)); scroll.appendChild(m); }
      else if (e.role === "tool") {
        const chev = icon("chevron", 18, "chev");
        const head = h("button", { class: "tool-head", type: "button", "aria-expanded": "false" },
          h("span", { class: "ico" }, icon("check", 18, "state-ico")), h("span", { class: "t" }, e.text), h("span", { class: "s" }, e.summary || ""), chev);
        const inside = h("div", { class: "in" }, ...(e.args ? argRows(e.args) : [h("div", { class: "muted" }, "这条旧记录没有保存更多参数。")]));
        const card = h("div", { class: "tool", dataset: { state: "done" } }, head, h("div", { class: "tool-body" }, h("div", null, inside)));
        head.addEventListener("click", () => { const open = card.classList.toggle("open"); head.setAttribute("aria-expanded", String(open)); });
        scroll.appendChild(card);
      }
      else if (e.role === "note") scroll.appendChild(h("div", { class: "msg note" }, e.text));
    }
    stick = true;
    scroll.scrollTop = scroll.scrollHeight;
  }
  async function loadConversation(id) {
    try { renderEntries((await runtime.conversations.get({ id })).entries); } catch { setConversation(null); resetChat(); }
  }
  events.on("conversation:load", (id) => (id ? loadConversation(id) : resetChat()));

  async function openConversations() {
    let list = [];
    try { list = (await runtime.conversations.list()).conversations; } catch (e) { return toast(e.message); }
    const body = h("div", { class: "convs" });
    let sheet;
    const fmt = (t) => new Date(t * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    body.appendChild(h("button", { class: "btn filled", type: "button", style: { marginBottom: "12px" }, onclick: () => { sheet.close(); setConversation(null); resetChat(); } }, icon("add", 18), "开始新对话"));
    if (!list.length) body.appendChild(h("p", { class: "muted" }, "这个项目还没有历史对话。"));
    for (const c of list) {
      body.appendChild(h("div", { class: "conv" + (c.id === state.get().conversationId ? " on" : "") },
        h("button", { type: "button", class: "ctitle", onclick: () => { sheet.close(); setConversation(c.id); loadConversation(c.id); } }, h("span", null, c.title), h("small", { class: "muted" }, `${fmt(c.updated)} · ${c.count} 条`)),
        h("button", { class: "icon-btn", type: "button", "aria-label": "删除这个对话", onclick: async () => {
          if (!(await confirmDialog({ title: "删除这个对话？", message: "只会删除对话记录，不会影响代码，也不影响时光机里的检查点。", confirmLabel: "删除", danger: true }))) return;
          await runtime.conversations.delete({ id: c.id });
          if (c.id === state.get().conversationId) { setConversation(null); resetChat(); }
          sheet.close();
        } }, icon("trash", 18))));
    }
    sheet = openSheet({ title: "对话历史", body });
  }

  paintHeader();
  showEmpty();
  return { el, focus: () => input.focus(), clear: () => { clear(scroll); cards.clear(); approvalEls.clear(); questionEls.clear(); showEmpty(); } };
}
