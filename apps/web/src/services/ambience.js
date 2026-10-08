// 项目创作房间。持久化由注入的项目 Store 经过 Workspace 完成；声音只在用户启动后生成。

export const AMBIENCE_SCENES = Object.freeze([
  { id: "rain", name: "雨夜书房", desc: "窗外轻雨，桌上一盏暖灯", symbol: "☂", accent: "#d7a96b", mixes: { rain: .55, cafe: .12, waves: 0, train: 0, synth: 0 } },
  { id: "ocean", name: "深海实验室", desc: "缓慢水波，留一点探索空间", symbol: "◌", accent: "#60c3cc", mixes: { rain: 0, cafe: 0, waves: .55, train: 0, synth: .15 } },
  { id: "neon", name: "霓虹车库", desc: "青紫灯光，今晚把原型造出来", symbol: "✧", accent: "#b49fea", mixes: { rain: 0, cafe: .1, waves: 0, train: 0, synth: .5 } },
  { id: "train", name: "夜行列车", desc: "阅读灯亮着，窗外慢慢经过远方", symbol: "▰", accent: "#a9bbd7", mixes: { rain: .1, cafe: 0, waves: 0, train: .5, synth: .08 } },
]);
export const AMBIENCE_LAYERS = Object.freeze([
  { id: "rain", name: "细雨" }, { id: "cafe", name: "咖啡馆低语" }, { id: "waves", name: "海浪" },
  { id: "train", name: "夜行列车" }, { id: "synth", name: "电子氛围" },
]);
export const AMBIENCE_INTENSITIES = Object.freeze([
  { id: "quiet", name: "静谧", gain: .45 }, { id: "daily", name: "日常", gain: .7 }, { id: "lively", name: "热闹", gain: 1 },
]);
export const MILESTONE_ITEMS = Object.freeze([{ id: "plant", name: "水草", symbol: "♧" }, { id: "stone", name: "石头", symbol: "●" }, { id: "bridge", name: "小桥", symbol: "⌒" }]);
export const POSTCARD_PREVIEW_LIMIT = 200 * 1024;
export const POSTCARD_PREVIEW_BUDGET = 700 * 1024;

const clip = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));
const short = (v, max = 400) => typeof v === "string" ? v.slice(0, max) : "";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const oneOf = (v, list, fallback) => list.some((s) => s.id === v) ? v : fallback;
const time = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
const identifier = (v) => short(v, 160).replace(/[\u0000-\u001f]/g, "");
const newId = () => globalThis.crypto?.randomUUID?.() || `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function sanitizePreview(value) {
  // 只保存小型位图；拒绝 SVG、远端地址及任意可执行内容。
  return typeof value === "string" && value.length <= POSTCARD_PREVIEW_LIMIT && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : "";
}

export function fitPostcardPreviews(cards) {
  let characters = 0, count = 0, exhausted = false;
  return cards.map((card) => {
    const preview = sanitizePreview(card.preview);
    if (!preview) return { ...card, preview: "" };
    if (exhausted || count >= 20 || characters + preview.length > POSTCARD_PREVIEW_BUDGET) { exhausted = true; return { ...card, preview: "" }; }
    characters += preview.length; count++; return { ...card, preview };
  });
}

export function normalizeAmbience(value) {
  const v = plain(value), scene = oneOf(v.scene, AMBIENCE_SCENES, "rain");
  const defaults = AMBIENCE_SCENES.find((s) => s.id === scene).mixes;
  const mixes = Object.fromEntries(AMBIENCE_LAYERS.map(({ id }) => [id, clip(plain(v.mixes)[id] ?? defaults[id])]));
  return { scene, intensity: oneOf(v.intensity, AMBIENCE_INTENSITIES, "daily"), volume: clip(v.volume ?? .35),
    sound: v.sound === true, foley: v.foley !== false, motion: v.motion !== false, pet: v.pet !== false, focus: v.focus === true, mixes };
}

function normalizeSession(v) {
  const s = plain(v);
  return { id: identifier(s.id), goal: short(s.goal, 240), startedAt: time(s.startedAt), endedAt: time(s.endedAt),
    paths: Array.isArray(s.paths) ? [...new Set(s.paths.filter((p) => typeof p === "string").map((p) => short(p, 300)))].slice(0, 100) : [],
    tasks: Array.isArray(s.tasks) ? [...new Set(s.tasks.map(identifier).filter(Boolean))].slice(0, 100) : [] };
}

export function normalizeRoom(value) {
  const v = plain(value);
  const postcards = fitPostcardPreviews((Array.isArray(v.postcards) ? v.postcards : []).slice(0, 60).map((x) => {
    const c = plain(x);
    return { id: identifier(c.id), title: short(c.title, 240), summary: short(c.summary, 1200), next: short(c.next, 400),
      createdAt: time(c.createdAt), startedAt: time(c.startedAt), scene: oneOf(c.scene, AMBIENCE_SCENES, "rain"),
      taskId: identifier(c.taskId), preview: sanitizePreview(c.preview), paths: normalizeSession(c).paths };
  }).filter((c) => c.id && c.createdAt));
  const milestones = (Array.isArray(v.milestones) ? v.milestones : []).slice(0, 36).map((x) => {
    const m = plain(x);
    return { id: identifier(m.id), title: short(m.title, 160), item: oneOf(m.item, MILESTONE_ITEMS, "plant"), createdAt: time(m.createdAt), taskId: identifier(m.taskId), postcardId: identifier(m.postcardId) };
  }).filter((m) => m.id && m.createdAt);
  return { ambience: normalizeAmbience(v.ambience), session: normalizeSession(v.session), postcards, milestones };
}

export function startRoomSession(value, goal, { now = new Date().toISOString(), id = newId() } = {}) {
  const room = normalizeRoom(value), cleanGoal = short(goal, 240).trim();
  if (!cleanGoal) throw new Error("写一句这次想做出的东西，再点亮桌灯。");
  if (room.session.startedAt && !room.session.endedAt) throw new Error("这次创作还没有收工，可以先修改今晚的目标。");
  return { session: { id, goal: cleanGoal, startedAt: now, endedAt: null, paths: [], tasks: [] } };
}

export function recordRoomActivity(value, { path, taskId } = {}) {
  const { session } = normalizeRoom(value);
  if (!session.startedAt || session.endedAt) return null;
  const paths = path ? [...new Set([...session.paths, short(path, 300)])].slice(-100) : session.paths;
  const tasks = taskId ? [...new Set([...session.tasks, identifier(taskId)])].slice(-100) : session.tasks;
  if (JSON.stringify(paths) === JSON.stringify(session.paths) && JSON.stringify(tasks) === JSON.stringify(session.tasks)) return null;
  return { session: { ...session, paths, tasks } };
}

export function finishRoomSession(value, { summary = "", next = "", preview = "", taskId = "", now = new Date().toISOString(), id = newId() } = {}) {
  const room = normalizeRoom(value), s = room.session;
  if (!s.startedAt || s.endedAt) throw new Error("先开工，再把这次创作收进明信片。");
  const card = { id, title: s.goal, summary: short(summary, 1200).trim(), next: short(next, 400).trim(), preview: sanitizePreview(preview),
    createdAt: now, startedAt: s.startedAt, scene: room.ambience.scene, taskId: identifier(taskId || s.tasks.at(-1)), paths: s.paths };
  return { session: { ...s, endedAt: now }, postcards: fitPostcardPreviews([card, ...room.postcards].slice(0, 60)) };
}

export function addRoomMilestone(value, { title, item = "plant", taskId = "", postcardId = "", now = new Date().toISOString(), id = newId() }) {
  const room = normalizeRoom(value), name = short(title, 160).trim();
  if (!name) throw new Error("给这个里程碑起个名字。");
  const milestone = { id, title: name, item: oneOf(item, MILESTONE_ITEMS, "plant"), createdAt: now, taskId: identifier(taskId), postcardId: identifier(postcardId) };
  return { milestones: [milestone, ...room.milestones].slice(0, 36) };
}

export function ambienceAgentState(state = {}) {
  if (state.approvals?.length) return { id: "waiting", label: "等你批准", pet: "举牌等你" };
  const agent = state.agent || {};
  if (agent.state === "error") return { id: "error", label: "需要检查错误", pet: "陪你排查" };
  if (!agent.running) return { id: "idle", label: agent.state === "stopped" ? "任务已停止" : "桌边待命", pet: "休息中" };
  if (["waiting_user", "waiting_approval"].includes(agent.state)) return { id: "waiting", label: "等你回答", pet: "举牌等你" };
  if (agent.state === "reading" || agent.state === "searching") return { id: "reading", label: "正在翻阅项目", pet: "探头读文件" };
  if (agent.state === "editing") return { id: "editing", label: "正在修改文件", pet: "搬小石头" };
  if (agent.state === "running") return { id: "running", label: "正在运行命令", pet: "观察运行结果" };
  return { id: "thinking", label: "正在思考", pet: "游一会儿" };
}

// 五条连续合成轨道。没有音频下载、麦克风权限或服务端依赖。
export function createAmbienceAudio({ AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext, random = Math.random } = {}) {
  let context = null, master = null, activated = false, hidden = false, disposed = false, settings = normalizeAmbience(null), lastFoley = -Infinity;
  const channels = new Map(), sources = new Set();
  const disconnect = () => {
    for (const node of sources) { try { node.stop(); } catch { /* 已停止 */ } try { node.disconnect(); } catch { /* 已释放 */ } }
    sources.clear();
    for (const node of channels.values()) { try { node.disconnect(); } catch { /* 已释放 */ } }
    channels.clear();
  };
  const ramp = (param, value, duration = .35) => {
    param.cancelScheduledValues(context.currentTime);
    param.setTargetAtTime(value, context.currentTime, duration);
  };
  const oscillator = (frequency, dest, type = "sine", level = .05) => {
    const source = context.createOscillator(), gain = context.createGain();
    source.type = type; source.frequency.value = frequency; gain.gain.value = level;
    source.connect(gain); gain.connect(dest); source.start(); sources.add(source); return source;
  };
  const noise = (dest, type, frequency, volume = .3) => {
    const source = context.createBufferSource(), buffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel); let last = 0;
      for (let i = 0; i < data.length; i++) { last = (last + (random() * 2 - 1) * .025) / 1.025; data[i] = last * 3.4; }
    }
    const filter = context.createBiquadFilter(), gain = context.createGain();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = .5; gain.gain.value = volume;
    source.buffer = buffer; source.loop = true; source.connect(filter); filter.connect(gain); gain.connect(dest);
    source.start(); sources.add(source); return gain;
  };
  const build = () => {
    master = context.createGain(); master.gain.value = 0; master.connect(context.destination);
    for (const { id } of AMBIENCE_LAYERS) { const channel = context.createGain(); channel.gain.value = 0; channel.connect(master); channels.set(id, channel); }
    noise(channels.get("rain"), "highpass", 500, .8);
    noise(channels.get("cafe"), "bandpass", 420, .3);
    const waves = noise(channels.get("waves"), "lowpass", 800, .4);
    oscillator(.08, waves.gain, "sine", .22);
    const train = noise(channels.get("train"), "bandpass", 160, .35);
    oscillator(1.35, train.gain, "sine", .16); oscillator(53, channels.get("train"), "sine", .018);
    for (const hz of [110, 164.81, 220, 277.18]) oscillator(hz, channels.get("synth"), "sine", .02);
  };
  const apply = () => {
    if (!context || !master) return;
    ramp(master.gain, hidden || !settings.sound ? 0 : settings.volume * AMBIENCE_INTENSITIES.find((s) => s.id === settings.intensity).gain * .65);
    for (const [id, node] of channels) ramp(node.gain, settings.mixes[id]);
  };
  async function start() {
    if (disposed) throw new Error("创作房间已经关闭。");
    if (!AudioContext) throw new Error("当前设备不支持环境声音，可以继续使用场景与桌边锦鲤。");
    if (hidden) return false;
    if (!context) { context = new AudioContext(); build(); }
    await context.resume();
    activated = true;
    settings = { ...settings, sound: true }; apply(); return true;
  }
  return {
    start,
    configure(value) { settings = normalizeAmbience(value); apply(); if (activated && !hidden && settings.sound && context?.state === "suspended") context.resume().catch(() => {}); },
    setHidden(value) {
      hidden = !!value; apply();
      if (hidden) context?.suspend().catch(() => {});
      else if (activated && settings.sound) context?.resume().catch(() => {});
    },
    foley(kind) {
      if (!context || !activated || hidden || !settings.sound || !settings.foley || context.state !== "running") return false;
      const now = context.currentTime;
      if (now - lastFoley < .45 || !["saved", "checkpoint", "verified"].includes(kind)) return false;
      lastFoley = now;
      const tones = kind === "verified" ? [523.25, 783.99] : kind === "checkpoint" ? [196, 293.66] : [440];
      tones.forEach((hz, i) => {
        const source = context.createOscillator(), gain = context.createGain(), at = now + i * .055;
        source.type = "sine"; source.frequency.value = hz;
        gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.13, at + .012); gain.gain.exponentialRampToValueAtTime(.001, at + .24);
        source.connect(gain); gain.connect(master); sources.add(source);
        source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
        source.start(at); source.stop(at + .26);
      });
      return true;
    },
    get status() { return { supported: !!AudioContext, activated, playing: activated && settings.sound && !hidden && context?.state === "running" }; },
    async dispose() { disposed = true; activated = false; disconnect(); try { await context?.close(); } catch { /* 浏览器可能已关闭上下文 */ } context = null; master = null; },
  };
}
