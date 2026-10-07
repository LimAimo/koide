// Agent status capsule. When the text changes the capsule's width morphs (FLIP) instead of snapping.

import { h } from "./dom.js";
import { state, runtime } from "../services/app.js";

const LABEL = {
  idle: "就绪", thinking: "思考中", reading: "读取中", searching: "搜索中", editing: "修改中", running: "运行中",
  working: "处理中", waiting_approval: "等待你批准", waiting_user: "等待你回答", stopped: "已停止", error: "出错了",
};

export function createCapsule() {
  const glyph = h("span", { class: "glyph" });
  const txt = h("span", { class: "txt" });
  const el = h("div", { class: "capsule", role: "status", "aria-live": "polite" }, glyph, txt);
  let last = "";

  function render() {
    const s = state.get();
    let key, text;
    if (s.conn !== "online") { key = s.conn === "connecting" ? "working" : "offline"; text = s.conn === "connecting" ? (runtime.kind === "native" ? "本地环境连接中…" : "连接中…") : (runtime.kind === "native" ? "本地环境未连接" : "网页模式"); }
    else if (s.agent.running || s.agent.state !== "idle") {
      key = s.agent.state; text = LABEL[key] || key;
      if (s.agent.detail && ["reading", "searching", "editing", "running", "waiting_approval", "waiting_user"].includes(key)) text = s.agent.detail;
    } else { key = "online"; text = s.workspace ? "就绪" : (runtime.kind === "native" ? "本地环境已就绪" : "已连接桥接服务"); }
    const sig = key + "|" + text;
    if (sig === last) return;
    last = sig;
    const w0 = el.getBoundingClientRect().width;
    el.dataset.state = key;
    txt.textContent = text;
    if (!w0 || !el.animate || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const w1 = el.getBoundingClientRect().width;
    if (Math.abs(w1 - w0) > 1) el.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: 260, easing: "cubic-bezier(.2,0,0,1)" });
  }
  state.subscribe(render);
  render();
  return el;
}
