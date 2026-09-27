// 只描述已发生的交互结果；不为普通点击、工具流或后台任务反复发声/振动。
import { runtime } from "./runtime/index.js";
import { settingsStore } from "./store.js";

const KINDS = new Set(["snap", "confirm", "complete", "restore"]);
const audible = (kind) => kind === "complete" || kind === "restore";
const foreground = () => typeof document !== "undefined" && !document.hidden;

export function createFeedback({ transport = runtime, preferences = () => settingsStore.get().feedback,
  visible = foreground, now = () => performance.now(), playSound = playTone } = {}) {
  let haptics = false, lastAt = -Infinity;
  const seen = new Set();
  return {
    setCapabilities(capabilities) { haptics = transport.kind === "native" && capabilities?.haptics === true; },
    async emit(kind, { key } = {}) {
      const skipped = (reason) => ({ performed: false, sound: false, reason });
      if (!KINDS.has(kind)) return skipped("unknown_kind");
      if (key) {
        const id = `${kind}:${key}`;
        if (seen.has(id)) return skipped("duplicate");
        seen.add(id);
        if (seen.size > 64) seen.delete(seen.values().next().value);
      }
      if (!visible()) return skipped("background");
      const options = preferences() || {};
      const vibrate = haptics && options.haptics === true;
      const sound = audible(kind) && options.sound === true;
      if (!vibrate && !sound) return skipped("disabled");
      const time = now();
      if (time - lastAt < 120) return skipped("throttled");
      lastAt = time;
      let played = false;
      if (sound) { try { played = !!playSound(kind); } catch { /* 不影响任务结果 */ } }
      if (!vibrate) return { performed: false, sound: played, reason: played ? "sound_only" : "unavailable" };
      try {
        const result = await transport.feedback.emit({ kind });
        return { performed: result?.performed === true, sound: played, reason: result?.reason || "unavailable" };
      } catch { return { performed: false, sound: played, reason: "unavailable" }; }
    },
  };
}

let audio = null;
async function primeAudio() {
  if (!settingsStore.get().feedback?.sound || !foreground()) return false;
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return false;
    const context = audio ||= new Audio();
    if (context.state !== "running") await context.resume();
    if (audio !== context || !foreground() || !settingsStore.get().feedback?.sound) {
      if (context.state === "running") await context.suspend();
      return false;
    }
    return context.state === "running";
  } catch { return false; }
}

function playTone(kind) {
  if (!foreground() || audio?.state !== "running" || !settingsStore.get().feedback?.sound) return false;
  const tones = kind === "complete" ? [660, 880] : [660];
  tones.forEach((frequency, index) => {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    const start = audio.currentTime + index * 0.09;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.025, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.085);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(start + 0.09);
  });
  return true;
}

const feedback = createFeedback();
export const emitFeedback = (kind, options) => feedback.emit(kind, options);
export async function previewFeedback() { await primeAudio(); return emitFeedback("complete"); }
runtime.on("hello", (hello) => feedback.setCapabilities(hello.capabilities));
runtime.onStatus((status) => { if (status !== "online") feedback.setCapabilities(null); });
runtime.on("agent.done", (event) => {
  if (event.status === "done" && event.task_id) void emitFeedback("complete", { key: event.task_id });
});

let initialized = false;
export function initFeedback() {
  if (initialized) return;
  initialized = true;
  const unlock = (event) => { if (event.isTrusted !== false) void primeAudio(); };
  document.addEventListener("pointerdown", unlock, { passive: true });
  document.addEventListener("keydown", unlock);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && audio?.state === "running") void audio.suspend().catch(() => {});
  });
  settingsStore.subscribe((settings) => {
    if (!settings.feedback?.sound && audio) {
      const old = audio; audio = null;
      void old.close().catch(() => {});
    }
  });
}
