// Small observable store + persisted user settings.

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of subs) fn(state);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const KEY = "diffusion.settings.v1";

export const DEFAULT_SETTINGS = {
  theme: "system",            // system | light | dark | oled
  hue: 205,                   // Material-You style seed hue (0-360)
  fontSize: 14,
  density: "comfortable",     // compact | comfortable
  tabWidth: 2,
  filesVisible: true,         // 桌面端文件面板是否显示
  aiVisible: false,           // 进入项目后 AI 面板默认关闭；用户点击 AI 时再打开
  terminalVisible: false,     // 桌面端底部终端是否显示
  showHiddenFiles: false,     // 文件树是否显示 .git 等隐藏目录
  editorKind: "cm6",          // 兼容旧设置导入；产品界面固定使用 CodeMirror 6
  showMinimap: false,
  followAgentEdits: true,      // AI 创建或修改文件时自动打开并定位到改动位置
  anim: {
    mode: "auto",             // auto | manual   (AI-auto is planned)
    pack: "dissolve",
    manual: { move: "dissolve", delete: "dissolve", insert: "dissolve", transform: "dissolve", groupMove: "dissolve" },
    speed: 1, intensity: 1, density: 0.5, cinematic: false,
    reduced: "system",        // system | on | off
    playFor: { ai: true, undo: true },
  },
  agent: { mode: "agent", profile: null, reasoning: "auto", webSearch: false, limits: { max_tool_calls: 0, max_seconds: 0, max_repair_attempts: 8, max_tokens: 0, max_cost_usd: 0, max_repeated_failures: 3 } },
  bridge: { remembered: [] },
  toolbar: ["Tab", "⇤", "←", "→", "{ }", "( )", "[ ]", ";", ":", '"', "'", "/"],
  devMode: false,
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

export const settingsStore = createStore(load());

function load() {
  try { return merge(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(KEY) || "{}")); }
  catch { return structuredClone(DEFAULT_SETTINGS); }
}

export function saveSettings(patch) {
  settingsStore.set((s) => merge(s, patch));
  try { localStorage.setItem(KEY, JSON.stringify(settingsStore.get())); } catch { /* storage may be blocked */ }
}

export const exportSettings = () => JSON.stringify(settingsStore.get(), null, 2);
export function importSettings(text) {
  const obj = JSON.parse(text);
  if (typeof obj !== "object" || obj === null) throw new Error("not a settings object");
  settingsStore.set(merge(DEFAULT_SETTINGS, obj));
  try { localStorage.setItem(KEY, JSON.stringify(settingsStore.get())); } catch { /* ignore */ }
}
export function resetSettings() {
  settingsStore.set(structuredClone(DEFAULT_SETTINGS));
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Apply theme + editor metrics to the document root as CSS variables / attributes. */
export function applyTheme(s = settingsStore.get()) {
  const root = document.documentElement;
  const dark = s.theme === "dark" || s.theme === "oled" || (s.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = s.theme === "oled" ? "oled" : dark ? "dark" : "light";
  root.style.setProperty("--hue", String(s.hue));
  root.style.setProperty("--fs", `${s.fontSize}px`);
  root.style.setProperty("--lh", `${Math.round(s.fontSize * (s.density === "compact" ? 1.4 : 1.65))}px`);
  root.style.setProperty("--tab", String(s.tabWidth));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--surface").trim() || "#101418");
}

export function reducedMotion(s = settingsStore.get()) {
  return s.anim.reduced === "on" || (s.anim.reduced === "system" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}
