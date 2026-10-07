import { h, icon, clear, toast } from "./dom.js";
import { openSheet, openDialog } from "./overlays.js";
import { reducedMotion, settingsStore } from "../services/store.js";
import { AMBIENCE_SCENES, AMBIENCE_LAYERS, AMBIENCE_INTENSITIES, MILESTONE_ITEMS, normalizeRoom, normalizeAmbience,
  startRoomSession, finishRoomSession, recordRoomActivity, addRoomMilestone, ambienceAgentState, createAmbienceAudio } from "../services/ambience.js";

const dateLabel = (v) => v ? new Date(v).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const field = (name, control) => h("label", { class: "ambience-field" }, h("span", null, name), control);
const button = (name, fn, cls = "") => h("button", { type: "button", class: `btn ${cls || "tonal"}`, onclick: fn }, name);
const section = (name, desc, ...children) => h("section", { class: "ambience-section" }, h("h3", null, name), desc && h("p", { class: "ambience-caption" }, desc), ...children);
const input = (name, value = "", maxLength = 240) => h("input", { class: "text-field", type: "text", "aria-label": name, value, maxlength: maxLength });
const textarea = (name, value = "", maxLength = 1200) => { const el = h("textarea", { class: "text-field", rows: "3", "aria-label": name, maxlength: maxLength }); el.value = value; return el; };
const empty = (text) => h("p", { class: "ambience-empty" }, text);
const svgNode = (tag, props) => { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [name, value] of Object.entries(props)) node.setAttribute(name, String(value)); return node; };

export function createAmbience({ app, projectStore, state, events, runtime, onFocus = () => {}, onTaskPanel = () => {}, onOpenCheckpoint = () => {}, getPreview = async () => "", audioFactory = createAmbienceAudio, audio = audioFactory() }) {
  let disposed = false, sheet = null, draft = null, savingTimer = null, pulseTimer = null, queue = Promise.resolve(), latestProject = "", activityState = "idle", panelFingerprint = "", lastFocus = false;
  const offs = [], media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"), rooms = () => normalizeRoom(projectStore.get());
  let projectVersion = 0, lastProjectIdentity;
  const currentProject = () => {
    const identity = JSON.stringify(state?.get()?.workspace?.location || state?.get()?.workspace?.roots || null);
    if (identity !== lastProjectIdentity) { lastProjectIdentity = identity; projectVersion++; }
    return `${projectVersion}:${identity}`;
  };
  const hasProject = () => !!state?.get()?.workspace;
  const ambientButton = h("button", { class: "icon-btn ambience-button", type: "button", "aria-label": "创作房间", title: "创作房间", onclick: () => open() }, icon("spark", 20));
  const lamp = h("div", { class: "ambience-lamp", "aria-hidden": "true" }, h("span"));
  const fishBody = h("span", { class: "koi-body" }, h("span", { class: "koi-spot" }), h("span", { class: "koi-eye" }));
  const fish = h("span", { class: "ambience-koi", "aria-hidden": "true" }, h("span", { class: "koi-tail" }), h("span", { class: "koi-fin" }), fishBody, h("span", { class: "koi-pebble" }), h("span", { class: "koi-sign" }, "!"));
  const petText = h("span", { class: "ambience-pet-label" });
  const pet = h("button", { class: "ambience-pet", type: "button", onclick: () => onTaskPanel() }, fish, petText);
  const el = h("div", { class: "ambience-overlay" }, lamp, pet);

  function enqueue(work, project = currentProject()) {
    const run = queue.catch(() => {}).then(async () => {
      if (disposed || project !== currentProject() || !hasProject()) return;
      return work();
    });
    queue = run; return run;
  }
  async function persist(patch) { await projectStore.update(patch); }
  function requireProject(project) { if (!hasProject() || currentProject() !== project) throw new Error("项目已经切换，请在当前项目重新打开创作房间。"); }
  function report(error) { toast(error?.message || "创作房间保存失败，请稍后重试。"); }
  function editAmbience(patch, { delay = false } = {}) {
    if (!hasProject()) return;
    draft = normalizeAmbience({ ...(draft || rooms().ambience), ...patch });
    paint();
    const project = currentProject();
    clearTimeout(savingTimer);
    const save = () => {
      const chosen = draft;
      enqueue(() => persist({ ambience: chosen }), project).then(() => { if (draft === chosen) draft = null; paint(); }).catch((error) => { if (draft === chosen) draft = null; paint(); report(error); });
    };
    if (delay) savingTimer = setTimeout(save, 300); else save();
  }
  function paint() {
    const config = draft || rooms().ambience, model = state?.get?.() || {}, status = ambienceAgentState(model);
    activityState = status.id;
    const focus = config.focus && hasProject();
    if (lastFocus !== focus) { lastFocus = focus; onFocus(focus); }
    const motion = config.motion && !reducedMotion() && !document.hidden;
    if (app) {
      app.dataset.ambienceScene = config.scene; app.dataset.ambienceIntensity = config.intensity;
      app.dataset.ambienceMotion = String(motion); app.dataset.ambienceState = status.id;
      app.classList.toggle("ambience-focus", focus);
      app.classList.toggle("ambience-needs-attention", status.id === "waiting" || status.id === "error");
    }
    el.hidden = ambientButton.hidden = !hasProject();
    el.dataset.state = status.id; el.dataset.motion = String(motion); el.dataset.scene = config.scene; el.dataset.intensity = config.intensity;
    pet.hidden = !config.pet;
    pet.title = `桌边锦鲤：${status.label}。点击查看任务。`;
    pet.setAttribute("aria-label", pet.title); petText.textContent = status.id === "waiting" || status.id === "error" ? status.label : "";
    audio.configure(config);
    updateAudioButton();
  }
  function pulse(kind) {
    if (!hasProject()) return;
    audio.foley(kind);
    if (kind === "verified") {
      el.dataset.verified = "true"; clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => { el.dataset.verified = "false"; }, 1400);
    }
  }
  function trackActivity(activity) {
    enqueue(async () => { const patch = recordRoomActivity(projectStore.get(), activity); if (patch) await persist(patch); }).catch(report);
  }
  function onStoreChanged() {
    if (disposed) return;
    paint();
    const room = rooms();
    // 活动路径变化不重建表单，避免 AI 写文件时打断用户输入。
    const fingerprint = JSON.stringify([room.ambience, room.session.id, room.session.goal, room.session.endedAt, room.postcards, room.milestones]);
    if (sheet && fingerprint !== panelFingerprint && !sheet.el.contains(document.activeElement)) renderPanel();
  }
  let audioButton = null, audioNote = null;
  function updateAudioButton() {
    if (audioButton) {
      audioButton.textContent = audio.status.playing ? "暂停声音" : "启动声音";
      audioButton.setAttribute("aria-pressed", String(!!audio.status.playing));
    }
    if (audioNote) audioNote.textContent = document.hidden ? "已在后台暂停" : audio.status.playing ? "声音正在本机合成" : "点击启动后才会发声，每次打开都由你决定";
  }
  async function toggleAudio() {
    const project = currentProject(), instance = audio;
    try {
      if (audio.status.playing) editAmbience({ sound: false });
      else { await instance.start(); requireProject(project); if (instance !== audio) return; editAmbience({ sound: true }); }
      updateAudioButton();
    } catch (error) { report(error); }
  }
  function switchControl(name, checked, fn) {
    const control = h("input", { type: "checkbox", role: "switch", "aria-label": name }); control.checked = checked;
    control.addEventListener("change", () => fn(control.checked));
    return h("label", { class: "ambience-switch" }, h("span", null, name), control);
  }
  function rangeControl(name, value, fn) {
    const control = h("input", { type: "range", min: "0", max: "100", step: "1", "aria-label": name }); control.value = Math.round(value * 100);
    const output = h("output", null, `${control.value}%`);
    control.addEventListener("input", () => { output.textContent = `${control.value}%`; fn(Number(control.value) / 100); });
    return h("label", { class: "ambience-range" }, h("span", null, name), control, output);
  }
  function sceneHero(config) {
    const scene = AMBIENCE_SCENES.find((s) => s.id === config.scene), session = rooms().session;
    return h("div", { class: "ambience-hero", dataset: { scene: config.scene } },
      h("div", { class: "ambience-scene-art", "aria-hidden": "true" }, h("span", { class: "room-moon" }), h("span", { class: "room-rain" }), h("span", { class: "room-horizon" }), h("span", { class: "room-light" }), h("span", { class: "room-desk" }), h("span", { class: "room-window" })),
      h("div", { class: "ambience-hero-copy" }, h("span", { class: "ambience-eyebrow" }, session.startedAt && !session.endedAt ? "桌灯已亮 · 创作进行中" : "留一间房，慢慢造东西"), h("h2", null, scene.name), h("p", null, scene.desc)));
  }
  function renderPanel() {
    if (!sheet) return;
    const room = rooms(), config = draft || room.ambience, body = sheet.content;
    panelFingerprint = JSON.stringify([room.ambience, room.session.id, room.session.goal, room.session.endedAt, room.postcards, room.milestones]);
    clear(body);
    const panel = h("div", { class: "ambience-panel", dataset: { scene: config.scene } });
    const scenes = h("div", { class: "ambience-scenes", role: "group", "aria-label": "创作场景" });
    for (const scene of AMBIENCE_SCENES) scenes.append(h("button", { class: "ambience-scene-choice", type: "button", dataset: { scene: scene.id }, "aria-pressed": String(scene.id === config.scene),
      onclick: () => { editAmbience({ scene: scene.id, mixes: { ...scene.mixes } }); renderPanel(); } }, h("span", { class: "scene-symbol", "aria-hidden": "true" }, scene.symbol), h("span", null, h("strong", null, scene.name), h("small", null, scene.desc))));
    const intensity = h("div", { class: "segmented ambience-intensity", role: "group", "aria-label": "氛围强度" });
    for (const item of AMBIENCE_INTENSITIES) intensity.append(h("button", { type: "button", "aria-pressed": String(item.id === config.intensity), onclick: () => { editAmbience({ intensity: item.id }); for (const child of intensity.children) child.setAttribute("aria-pressed", String(child.textContent === item.name)); } }, item.name));
    const settings = h("div", { class: "ambience-toggles" },
      switchControl("桌边锦鲤", config.pet, (pet) => editAmbience({ pet })),
      switchControl("场景动态", config.motion, (motion) => editAmbience({ motion })),
      switchControl("操作声音", config.foley, (foley) => editAmbience({ foley })),
      switchControl("心流布局", config.focus, (focus) => editAmbience({ focus })));
    audioButton = button("启动声音", toggleAudio, "filled"); audioButton.disabled = !audio.status.supported;
    audioNote = h("small", { class: "ambience-caption" });
    const audioHeader = h("div", { class: "ambience-audio-head" }, audioButton, audioNote);
    const mixes = h("div", { class: "ambience-mixer" }, rangeControl("总音量", config.volume, (volume) => editAmbience({ volume }, { delay: true })));
    for (const layer of AMBIENCE_LAYERS) mixes.append(rangeControl(layer.name, config.mixes[layer.id], (volume) => editAmbience({ mixes: { ...(draft || rooms().ambience).mixes, [layer.id]: volume } }, { delay: true })));
    panel.append(sceneHero(config), section("你的创作房间", "每个项目独立保存。切换场景会带上推荐混音。", scenes, intensity, settings,
      reducedMotion() && h("p", { class: "ambience-caption" }, "已遵循减少动态效果设置。")), section("听见一点环境", "五条本地合成音轨，拖动混音就能找到自己的节奏。", audioHeader, mixes));
    panel.append(renderSession(room), renderWorld(room), renderPostcards(room));
    body.append(panel); updateAudioButton();
  }
  function renderSession(room) {
    const project = currentProject(), s = room.session, active = s.startedAt && !s.endedAt;
    const goal = input("这次想做出什么", active ? s.goal : "", 240); goal.placeholder = "今晚，我想做出……";
    const saveGoal = button(active ? "更新目标" : "点亮桌灯，开工", async () => {
      try {
        requireProject(project);
        await enqueue(() => {
          const now = rooms();
          if (active) { const value = goal.value.trim(); if (!value) throw new Error("目标还空着，写一句想做出的东西。"); return persist({ session: { ...now.session, goal: value.slice(0, 240) } }); }
          return persist(startRoomSession(projectStore.get(), goal.value));
        });
        renderPanel(); toast(active ? "目标已更新" : "桌灯亮了，慢慢来。");
      } catch (error) { report(error); }
    }, "filled");
    const actions = h("div", { class: "ambience-actions" }, saveGoal);
    if (active) actions.append(button("收工，留一张明信片", () => endSession()));
    return section(active ? "这次创作" : "开工仪式", active ? `${dateLabel(s.startedAt)} 开始 · 实际修改 ${s.paths.length} 个文件` : "一句目标，就足够开始。", field("想做出什么", goal), actions,
      active && h("small", { class: "ambience-caption" }, "收工时自己记录成果；任务结束不会自动被当成验收通过。"));
  }
  function endSession() {
    const project = currentProject();
    const summary = textarea("这次做出了什么"), next = input("下次从哪里继续", "", 400);
    summary.placeholder = "记录你确认过的成果，也可以写下还没解决的事情。"; next.placeholder = "下次回来，先做……";
    let dialog;
    dialog = openDialog({ title: "把今天收进明信片", body: h("div", { class: "ambience-form" }, field("这次做出了什么", summary), field("下次从哪里继续", next), h("small", { class: "ambience-caption" }, "会附上当前可用的预览截图和实际修改记录。")),
      actions: [{ label: "继续创作" }, { label: "收工", primary: true, onClick: async () => {
        try {
          requireProject(project);
          const screenshot = await Promise.resolve().then(getPreview).catch(() => "");
          if (project !== currentProject()) throw new Error("项目已经切换，请在当前项目重新收工。");
          await enqueue(() => persist(finishRoomSession(projectStore.get(), { summary: summary.value, next: next.value, preview: screenshot })), project);
          renderPanel(); toast("明信片已收好，下次见。");
        } catch (error) { report(error); return false; }
      } }], onClose: () => { dialog = null; } });
  }
  function renderWorld(room) {
    const world = h("div", { class: "ambience-world", "aria-label": "项目瓶中世界" }, h("span", { class: "world-water", "aria-hidden": "true" }), h("span", { class: "world-floor", "aria-hidden": "true" }));
    room.milestones.slice(0, 12).reverse().forEach((m, i) => world.append(h("button", { class: `world-item world-${m.item}`, type: "button", style: { left: `${8 + i % 6 * 14}%`, bottom: `${20 + Math.floor(i / 6) * 30}px` }, "aria-label": `里程碑：${m.title}`, title: m.title, onclick: () => inspectMilestone(m) }, h("span", { "aria-hidden": "true" }, MILESTONE_ITEMS.find((x) => x.id === m.item).symbol))));
    if (!room.milestones.length) world.append(h("span", { class: "world-invitation" }, "从一株水草开始"));
    return section("瓶中世界", "你认可一个里程碑，就给这个项目添一点风景。", world,
      h("div", { class: "ambience-actions" }, button("放入一个里程碑", () => newMilestone()), room.milestones.length > 12 && button(`查看全部 ${room.milestones.length} 个`, () => milestoneList(room))),
      room.milestones.length > 0 && h("small", { class: "ambience-caption" }, `已收藏 ${room.milestones.length} 个里程碑，点击摆件回看成果。`));
  }
  function newMilestone(card = null) {
    const project = currentProject();
    const title = input("里程碑名称", card?.title || "", 160), select = h("select", { class: "text-field", "aria-label": "瓶中摆件" });
    for (const item of MILESTONE_ITEMS) select.append(h("option", { value: item.id }, item.name));
    select.value = "plant";
    openDialog({ title: "添一点值得记住的风景", body: h("div", { class: "ambience-form" }, field("里程碑名称", title), field("瓶中摆件", select)),
      actions: [{ label: "取消" }, { label: "放进瓶中", primary: true, onClick: async () => {
        try { requireProject(project); await enqueue(() => persist(addRoomMilestone(projectStore.get(), { title: title.value, item: select.value, postcardId: card?.id || "", taskId: card?.taskId || state?.get()?.agent?.taskId || "" })), project); renderPanel(); }
        catch (error) { report(error); return false; }
      } }] });
  }
  function inspectMilestone(m) {
    const card = rooms().postcards.find((c) => c.id === m.postcardId);
    openDialog({ title: m.title, body: h("div", { class: "ambience-form" }, h("p", null, `${MILESTONE_ITEMS.find((x) => x.id === m.item).name} · ${dateLabel(m.createdAt)}`), card && card.summary && h("p", null, card.summary)),
      actions: [m.taskId && { label: "回看任务", onClick: () => onOpenCheckpoint(m.taskId) }, card && { label: "查看明信片", onClick: () => inspectCard(card) }, { label: "关闭" }].filter(Boolean) });
  }
  function milestoneList(room) {
    openSheet({ title: "瓶中的里程碑", body: h("div", { class: "ambience-milestones" }, room.milestones.map((m) => h("button", { class: "ambience-milestone-row", type: "button", onclick: () => inspectMilestone(m) }, MILESTONE_ITEMS.find((x) => x.id === m.item).symbol, h("span", null, m.title, h("small", null, dateLabel(m.createdAt)))))) });
  }
  function renderPostcards(room) {
    const cards = h("div", { class: "ambience-postcards" });
    for (const card of room.postcards.slice(0, 8)) cards.append(h("button", { class: "ambience-postcard", type: "button", dataset: { scene: card.scene }, onclick: () => inspectCard(card) },
      card.preview ? h("img", { src: card.preview, alt: "收工时的作品预览", loading: "lazy" }) : h("span", { class: "postcard-mark", "aria-hidden": "true" }, AMBIENCE_SCENES.find((s) => s.id === card.scene).symbol),
      h("span", { class: "postcard-copy" }, h("small", null, dateLabel(card.createdAt)), h("strong", null, card.title), h("span", null, card.summary || `实际修改 ${card.paths.length} 个文件`))));
    return section("成果明信片", "把做过的东西留下，回来时就知道从哪里继续。", room.postcards.length ? cards : empty("收工时，第一张明信片会放在这里。"),
      room.postcards.length > 8 && button(`翻看全部 ${room.postcards.length} 张`, () => openSheet({ title: "创作相册", body: h("div", { class: "ambience-album" }, room.postcards.map((card) => h("button", { class: "ambience-milestone-row", type: "button", onclick: () => inspectCard(card) }, h("span", null, card.title, h("small", null, dateLabel(card.createdAt)))))) })));
  }
  function inspectCard(card) {
    const body = h("div", { class: "ambience-card-detail" }, card.preview && h("img", { src: card.preview, alt: "收工时的作品预览" }), h("small", null, dateLabel(card.createdAt)),
      h("p", null, card.summary || "这次没有填写成果说明。"), card.next && h("p", null, `下次继续：${card.next}`), card.paths.length && h("details", null, h("summary", null, `实际修改了 ${card.paths.length} 个文件`), h("ul", null, card.paths.map((path) => h("li", null, path)))));
    openSheet({ title: card.title, body, footer: [button("下载明信片", () => downloadCard(card)), button("收藏为里程碑", () => newMilestone(card)), card.taskId && button("回看任务", () => onOpenCheckpoint(card.taskId))].filter(Boolean) });
  }
  function downloadCard(card) {
    const scene = AMBIENCE_SCENES.find((s) => s.id === card.scene), svg = svgNode("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 960 640", width: "960", height: "640" });
    svg.append(svgNode("rect", { width: 960, height: 640, fill: "#11191e", rx: 24 }), svgNode("rect", { x: 40, y: 40, width: 880, height: 8, fill: scene.accent, rx: 4 }));
    const text = (value, x, y, size, fill = "#f2f0eb") => { const t = svgNode("text", { x, y, "font-size": size, fill, "font-family": "sans-serif" }); t.textContent = value; svg.append(t); };
    text("Koide · 创作明信片", 52, 88, 18, scene.accent); text(dateLabel(card.createdAt), 52, 118, 15, "#a8b4bb");
    const lines = (value, max) => { const chars = Array.from(value); return Array.from({ length: Math.ceil(chars.length / max) }, (_, i) => chars.slice(i * max, (i + 1) * max).join("")); };
    const titleLines = lines(card.title, 26).slice(0, 2); titleLines.forEach((line, i) => text(line, 52, 170 + i * 36, 28));
    if (card.preview) svg.append(svgNode("image", { href: card.preview, x: 52, y: 240, width: 430, height: 295, preserveAspectRatio: "xMidYMid meet" }));
    const x = card.preview ? 520 : 52, max = card.preview ? 17 : 39;
    lines(card.summary || `实际修改 ${card.paths.length} 个文件`, max).slice(0, 9).forEach((line, i) => text(line, x, 265 + i * 27, 17, "#d0d7db"));
    text(`下次：${Array.from(card.next || "带着新想法回来").slice(0, 43).join("")}`, 52, 590, 17, scene.accent);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
    const link = h("a", { href: url, download: `Koide-明信片-${card.createdAt.slice(0, 10)}.svg` }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function open() {
    if (!hasProject()) { toast("先打开一个项目，再布置它的创作房间。"); return; }
    if (sheet) return;
    sheet = openSheet({ title: "创作房间", tall: true, onClose: () => { sheet = null; audioButton = audioNote = null; } }); renderPanel();
  }
  const listen = (emitter, name, fn) => { if (emitter?.on) offs.push(emitter.on(name, fn)); };
  offs.push(projectStore.subscribe(onStoreChanged));
  offs.push(settingsStore.subscribe(paint));
  if (state?.subscribe) offs.push(state.subscribe(() => {
    const project = currentProject();
    if (project !== latestProject) {
      latestProject = project; draft = null; clearTimeout(savingTimer);
      audio.configure({ ...rooms().ambience, sound: false }); audio.setHidden(true); // 切换项目后需要再次点声音。
      audio.dispose().catch(() => {});
      // 音频实例由下方切换生命周期重新建立。
      audio = audioFactory(); audio.setHidden(!!document.hidden);
      if (sheet) { sheet.close(); sheet = null; }
    }
    paint();
  }));
  listen(runtime, "fs.changed", (change) => {
    if (/^(?:\.koide|\.diffusion)\//.test(String(change.path || "").replaceAll("\\", "/"))) return;
    if (change.actor === "user") pulse("saved");
    trackActivity({ path: change.path });
  });
  listen(runtime, "agent.started", (task) => { pulse("checkpoint"); trackActivity({ taskId: task.task_id }); });
  listen(events, "studio:checkpoint", () => pulse("checkpoint"));
  listen(events, "studio:verified", (result) => { if (result?.passed === true) pulse("verified"); });
  const visibility = () => { audio.setHidden(!!document.hidden); paint(); };
  document.addEventListener("visibilitychange", visibility);
  const motionChanged = () => paint(); media?.addEventListener?.("change", motionChanged);
  latestProject = currentProject(); audio.setHidden(!!document.hidden); paint();
  return { el, button: ambientButton, open, get state() { return { status: activityState, room: rooms() }; },
    async dispose() {
      disposed = true; clearTimeout(savingTimer); clearTimeout(pulseTimer); sheet?.close();
      if (lastFocus) { lastFocus = false; onFocus(false); }
      offs.forEach((off) => off?.()); document.removeEventListener?.("visibilitychange", visibility); media?.removeEventListener?.("change", motionChanged);
      if (app) { app.classList.remove("ambience-focus", "ambience-needs-attention"); for (const name of ["ambienceScene", "ambienceIntensity", "ambienceMotion", "ambienceState"]) delete app.dataset[name]; }
      el.remove(); ambientButton.remove(); await audio.dispose();
    } };
}
