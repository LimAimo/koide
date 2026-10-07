import { h, clear, toast } from "./dom.js";
import { openSheet } from "./overlays.js";
import { events, state } from "../services/app.js";
import { projectStore, studioState, getProjectEpoch, assertProjectEpoch, addAttachment, removeAttachment } from "../services/studio.js";
export function createContextInput() {
  const files = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true, "aria-label": "选择参考图片" });
  const tray = h("div", { class: "studio-attachment-tray", "aria-label": "本轮图片附件" });
  const attach = h("button", { type: "button", class: "icon-btn", title: "添加参考图", "aria-label": "添加参考图", onclick: () => files.click() }, "+");
  const context = h("button", { type: "button", class: "btn text", "aria-label": "查看本轮上下文", onclick: () => {
    const p = projectStore.get(), s = studioState.get();
    const list = h("div", { class: "studio-context-sheet" },
      h("p", null, "以下内容会在发送前读取，项目约定和任务卡也会随本轮发送。"),
      h("ul", null, (p.context || []).map((path) => h("li", null, h("code", null, path)))),
      (p.memories || []).filter((m) => m.active !== false && !m.stale).map((m) => h("p", null, `记忆：${m.text}`)),
      s.selections.map((x) => h("details", null, h("summary", null, `选区：${x.path}`), h("pre", null, x.text))),
      h("p", null, `图片 ${s.attachments.length} 张 · 当前文件 ${state.get().active || "无"}`));
    openSheet({ title: "本轮上下文", body: list, tall: true });
  } }, "上下文");
  files.addEventListener("change", async () => {
    const epoch = getProjectEpoch();
    for (const file of files.files || []) {
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5 MiB`);
        const data_url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(file); });
        assertProjectEpoch(epoch);
        addAttachment({ name: file.name, data_url });
      } catch (e) { toast(e.message); }
    }
    files.value = "";
  });
  function paint() {
    clear(tray);
    studioState.get().attachments.forEach((a, i) => tray.append(h("div", { class: "studio-attachment" }, h("img", { src: a.data_url, alt: a.name }), h("button", { type: "button", class: "btn text", onclick: () => annotate(a), "aria-label": `标注 ${a.name}` }, "圈选"), h("button", { type: "button", class: "btn text", onclick: () => removeAttachment(i), "aria-label": `移除 ${a.name}` }, "×"))));
  }
  async function annotate(attachment) {
    const epoch = getProjectEpoch();
    try {
      const image = new Image(); image.src = attachment.data_url; await image.decode();
      assertProjectEpoch(epoch);
      const canvas = h("canvas", { width: Math.min(1400, image.width), height: Math.round(image.height * Math.min(1, 1400 / image.width)) });
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      let drawing = false;
      const point = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
      canvas.addEventListener("pointerdown", (e) => { drawing = true; canvas.setPointerCapture?.(e.pointerId); ctx.beginPath(); ctx.moveTo(...point(e)); });
      canvas.addEventListener("pointermove", (e) => { if (!drawing) return; ctx.lineWidth = Math.max(3, canvas.width / 300); ctx.strokeStyle = "#ff435f"; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineTo(...point(e)); ctx.stroke(); });
      for (const name of ["pointerup", "pointercancel"]) canvas.addEventListener(name, () => { drawing = false; });
      const sheet = openSheet({ title: "圈选参考图", body: h("div", { class: "studio-annotation-stage" }, canvas), tall: true, footer: h("button", { class: "btn filled", type: "button", onclick: () => {
        try { assertProjectEpoch(epoch); addAttachment({ name: `${attachment.name}（标注）`, data_url: canvas.toDataURL("image/png") }); sheet.close(); } catch (e) { toast(e.message); }
      } }, "附加标注图") });
    } catch (e) { toast(e.message); }
  }
  studioState.subscribe(paint); paint();
  events.on("studio:pick-image", () => files.click());
  events.on("studio:annotate-image", () => { const a = studioState.get().attachments.at(-1); a ? annotate(a) : toast("先添加一张参考图或预览截图"); });
  return { tools: h("div", { class: "studio-composer-tools" }, files, attach, context), tray };
}
