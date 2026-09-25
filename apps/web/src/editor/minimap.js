// 缩略图：把整个文件按每行 2 像素画在右侧，点击或拖动可以跳转。只用于内置编辑器，手机上默认关闭。

import { highlightLine } from "./highlight.js";

const W = 90, LH = 2;

export class Minimap {
  constructor(scroller, getText, getLang) {
    this.scroller = scroller;
    this.getText = getText;
    this.getLang = getLang;
    this.total = 0;
    this.offset = 0;
    this.raf = 0;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ce-minimap";
    this.view = document.createElement("div");
    this.view.className = "ce-minimap-view";
    this.box = document.createElement("div");
    this.box.className = "ce-minimap-box";
    this.box.setAttribute("aria-hidden", "true");
    this.box.append(this.canvas, this.view);
    scroller.addEventListener("scroll", () => this.schedule());
    let down = false;
    const jump = (e) => {
      const r = this.box.getBoundingClientRect();
      const frac = (e.clientY - r.top + this.offset) / (this.total || 1);
      scroller.scrollTop = frac * scroller.scrollHeight - scroller.clientHeight / 2;
    };
    this.box.addEventListener("pointerdown", (e) => { down = true; if (this.box.setPointerCapture) this.box.setPointerCapture(e.pointerId); jump(e); });
    this.box.addEventListener("pointermove", (e) => { if (down) jump(e); });
    for (const t of ["pointerup", "pointercancel"]) this.box.addEventListener(t, () => { down = false; });
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw() {
    const sc = this.scroller, H = sc.clientHeight || 400;
    const lines = this.getText().split("\n").slice(0, 4000);
    this.total = lines.length * LH;
    const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
    this.offset = this.total > H ? (sc.scrollTop / maxScroll) * (this.total - H) : 0;
    const sh = sc.scrollHeight || 1;
    this.view.style.cssText = `top:${(sc.scrollTop / sh) * this.total - this.offset}px;height:${Math.max(6, (sc.clientHeight / sh) * this.total)}px`;
    this.box.style.height = `${H}px`;
    const ctx = this.canvas.getContext && this.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.cssText = `width:${W}px;height:${H}px`;
    ctx.scale(dpr, dpr);
    const root = getComputedStyle(document.documentElement);
    const col = (n, fb) => root.getPropertyValue(n).trim() || fb;
    const colors = { "tk-kw": col("--tk-kw", "#c586c0"), "tk-str": col("--tk-str", "#7ee787"), "tk-num": col("--tk-num", "#e3b341"), "tk-com": col("--tk-com", "#6e7681"), "tk-fn": col("--tk-fn", "#79c0ff"), "tk-type": col("--tk-type", "#56d4dd") };
    const plain = col("--on-surface-variant", "#999");
    const lang = this.getLang();
    const first = Math.floor(this.offset / LH), last = Math.min(lines.length, Math.ceil((this.offset + H) / LH));
    for (let r = first; r < last; r++) {
      const line = lines[r], segs = highlightLine(line, lang), y = r * LH - this.offset;
      let k = 0;
      for (let i = 0; i < Math.min(line.length, W); i++) {
        const c = line[i];
        if (c === " " || c === "\t") continue;
        while (k < segs.length && segs[k].end <= i) k++;
        const seg = segs[k] && segs[k].start <= i ? segs[k] : null;
        ctx.globalAlpha = seg ? 0.95 : 0.5;
        ctx.fillStyle = seg ? colors[seg.cls] || plain : plain;
        ctx.fillRect(i, y, 1, LH - 0.5);
      }
    }
  }
}
