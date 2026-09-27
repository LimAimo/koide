// Project Memory: user-visible, editable project context that can also be injected into Agent prompts.

import { h, toast } from "./dom.js";
import { openSheet } from "./overlays.js";
import { runtime, state } from "../services/app.js";

export const PROJECT_MEMORY_PATH = ".koide/PROJECT_MEMORY.md";
const TEMPLATE = `# Project Memory

在这里记录那些“下次打开项目仍然应该知道”的事实，例如：

- 架构决定与取舍
- 项目约定
- 已知坑和不能回退的设计
- 重要术语、模块关系
- 需要长期遵守的实现偏好

这份文件由你控制。Koide 不会把聊天里的内容偷偷写进来；只有你明确保存的内容才会成为项目记忆。
`;

async function loadMemory() {
  try {
    const res = await runtime.files.read({ path: PROJECT_MEMORY_PATH });
    if (res.binary) throw new Error("项目记忆文件不是文本文件");
    return { text: res.content || "", revision: res.revision || null, exists: true };
  } catch (e) {
    if (e?.code === "NOT_FOUND") return { text: TEMPLATE, revision: null, exists: false };
    throw e;
  }
}

async function createMemory(text) {
  try { await runtime.files.create({ path: ".koide", kind: "dir", content: "" }); }
  catch (e) { if (e?.code !== "ALREADY_EXISTS") throw e; }
  try {
    return await runtime.files.create({ path: PROJECT_MEMORY_PATH, kind: "file", content: text });
  } catch (e) {
    if (e?.code !== "ALREADY_EXISTS") throw e;
    const current = await runtime.files.read({ path: PROJECT_MEMORY_PATH });
    return runtime.files.write({ path: PROJECT_MEMORY_PATH, content: text, base_revision: current.revision });
  }
}

export function openProjectMemory() {
  const textarea = h("textarea", {
    class: "text-field project-memory-editor", rows: "18", spellcheck: "false",
    placeholder: "记录这个项目应该长期记住的事实…",
    "aria-label": "项目记忆",
  });
  const meta = h("div", { class: "project-memory-meta muted" }, "正在读取项目记忆…");
  const intro = h("p", { class: "project-memory-intro" },
    "这是项目自己的长期上下文。内容保存在 ", h("code", null, PROJECT_MEMORY_PATH),
    "，你可以直接编辑、版本控制或删除它；Koide Agent 会在后续任务中读取它。");
  const body = h("div", { class: "project-memory" }, intro, meta, textarea);
  let revision = null, exists = false, saving = false;

  const save = async () => {
    if (saving || !state.get().workspace) return;
    saving = true;
    meta.textContent = "正在保存…";
    try {
      let res;
      if (exists) res = await runtime.files.write({ path: PROJECT_MEMORY_PATH, content: textarea.value, base_revision: revision });
      else res = await createMemory(textarea.value);
      revision = res?.revision || revision;
      exists = true;
      meta.textContent = "已保存 · 后续 Agent 任务会读取这份记忆";
      toast("项目记忆已保存");
    } catch (e) {
      meta.textContent = "保存失败：" + e.message;
      toast(e.message);
    } finally { saving = false; }
  };

  const sheet = openSheet({
    title: "项目记忆",
    tall: true,
    body,
    footer: [
      h("button", { class: "btn tonal", type: "button", onclick: save }, "保存"),
      h("button", { class: "btn text", type: "button", onclick: () => sheet.close() }, "关闭"),
    ],
  });

  loadMemory().then((m) => {
    textarea.value = m.text;
    revision = m.revision;
    exists = m.exists;
    meta.textContent = m.exists ? "已载入项目记忆" : "这个项目还没有记忆文件；首次保存时会创建";
  }).catch((e) => { meta.textContent = e.message; });
  return sheet;
}
