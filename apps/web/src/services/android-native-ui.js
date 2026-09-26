import { runtime, state, events } from "./app.js";
import { settingsStore } from "./store.js";

export function installAndroidNativeShell({ onFiles, onAI, onSettings } = {}) {
  if (runtime.kind !== "native" || !/Android/i.test(navigator.userAgent)) return () => {};
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (!invoke) return () => {};

  const handler = (event) => {
    const d = event.detail || {};
    if (d.action === "ready") {
      document.documentElement.classList.add("koide-native-shell");
      document.documentElement.style.setProperty("--native-shell-bottom", `${Number(d.bottom) || 88}px`);
    } else if (d.action === "files") onFiles?.();
    else if (d.action === "ai") onAI?.();
    else if (d.action === "settings") onSettings?.();
  };
  window.addEventListener("koide:native-ui", handler);

  const sync = () => {
    const st = state.get(), cfg = settingsStore.get();
    const profile = st.profiles.find((p) => p.id === cfg.agent.profile) || st.profiles[0];
    invoke("native_ui_state", { payload: {
      title: st.workspace?.name || "Koide",
      model: profile ? String(profile.name || profile.model || profile.id || "") : "",
      hasWorkspace: !!st.workspace,
      agentRunning: !!st.agent.running,
    }}).catch(() => {});
  };
  const offState = state.subscribe(sync);
  const offSettings = settingsStore.subscribe(sync);

  // Handshake after the web UI exists. Native shell is enhancement-only:
  // a failed handshake must leave the complete Web UI usable.
  requestAnimationFrame(() => {
    invoke("native_ui_ready")
      .then(() => sync())
      .catch(() => document.documentElement.classList.remove("koide-native-shell"));
  });
  return () => { window.removeEventListener("koide:native-ui", handler); offState?.(); offSettings?.(); };
}
