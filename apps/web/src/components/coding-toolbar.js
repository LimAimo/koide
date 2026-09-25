// Coding toolbar: symbol keys above the Android keyboard. Buttons never steal focus (pointerdown is cancelled),
// so the keyboard stays up while you tap. Keys are configurable in settings.toolbar.

import { h } from "./dom.js";
import { settingsStore } from "../services/store.js";

const PAIRS = { "{ }": ["{}", 1], "( )": ["()", 1], "[ ]": ["[]", 1] };

export function createCodingToolbar(getEditor) {
  const bar = h("div", { class: "code-toolbar", role: "toolbar", "aria-label": "代码符号键" });
  const sg = h("div", { class: "sg", hidden: true, "aria-label": "补全建议" });

  function build() {
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    bar.appendChild(sg);
    for (const key of settingsStore.get().toolbar) {
      const b = h("button", { type: "button", "aria-label": key === "Tab" ? "缩进" : key === "⇤" ? "反向缩进" : `输入 ${key}` }, key);
      b.addEventListener("pointerdown", (e) => e.preventDefault());       // keep the keyboard open
      b.addEventListener("click", () => act(key));
      bar.appendChild(b);
    }
  }

  function act(key) {
    const ed = getEditor();
    if (!ed) return;
    if (key === "Tab") ed.indent(1);
    else if (key === "⇤") ed.indent(-1);
    else if (key === "←") ed.moveCaret(-1);
    else if (key === "→") ed.moveCaret(1);
    else if (PAIRS[key]) { ed.insertText(PAIRS[key][0]); ed.moveCaret(-PAIRS[key][1]); }
    else ed.insertText(key);
  }

  const coarse = () => matchMedia("(pointer: coarse)").matches;
  function position() {
    const vv = window.visualViewport;
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty("--kb", `${kb}px`);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", position);
    window.visualViewport.addEventListener("scroll", position);
  }

  build();
  settingsStore.subscribe(build);
  document.body.appendChild(bar);

  const outsideFocus = (e) => {
    const ed = getEditor();
    if (!bar.classList.contains("show") || !ed?.el) return;
    if (ed.el.contains?.(e.target) || bar.contains?.(e.target)) return;
    bar.classList.remove("show");
  };
  document.addEventListener("focusin", outsideFocus);

  function setSuggestions(words, pick) {
    while (sg.firstChild) sg.removeChild(sg.firstChild);
    for (const w of words) {
      const b = h("button", { type: "button", "aria-label": `补全 ${w}` }, w);
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => pick(w));
      sg.appendChild(b);
    }
    sg.hidden = !words.length;
    if (words.length) { position(); bar.classList.add("show"); } else if (!coarse()) bar.classList.remove("show");
  }
  return {
    el: bar, setSuggestions,
    show() { if (coarse()) { position(); bar.classList.add("show"); } },
    hide() { bar.classList.remove("show"); },
    destroy() { document.removeEventListener?.("focusin", outsideFocus); bar.remove(); },
  };
}
