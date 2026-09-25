// Git 面板：分支、改动、差异、暂存、提交、拉取推送、提交历史、逐行追溯。
// 不提供强制推送；版本回退分为软回退与受保护的强制回退，后者仍通过 Workspace/回收站恢复文件。

import { h, icon, clear, toast, append } from "./dom.js";
import { openSheet, openMenu, confirmDialog, promptDialog } from "./overlays.js";
import { runtime, state, activeTab, refreshGit } from "../services/app.js";

const LABEL = { M: "已修改", A: "新增", D: "已删除", R: "重命名", C: "复制", U: "未跟踪", "?": "未跟踪" };

function diffView(text) {
  const pre = h("pre", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
    pre.appendChild(h("div", { class: cls }, line || "\u200b"));
  }
  return pre;
}

export async function openDiff(path, staged) {
  try {
    const { diff } = await runtime.git.diff({ path, staged });
    openSheet({ title: `${path}${staged ? "（已暂存）" : ""}`, tall: true, body: diff.trim() ? diffView(diff) : h("p", { class: "muted", style: { padding: "12px" } }, "没有可显示的差异。") });
  } catch (e) { toast(e.message); }
}

export function openBlame() {
  const t = activeTab();
  if (!t) return toast("请先打开一个文件");
  runtime.git.blame({ path: t.path }).then(({ lines }) => {
    const src = t.text.split("\n"), box = h("div", { class: "blame" });
    lines.slice(0, 2000).forEach((b, i) => box.appendChild(h("div", { class: "bl" }, h("span", { class: "who" }, `${b.hash} ${b.author}`), h("span", { class: "code-line" }, src[i] ?? ""))));
    openSheet({ title: `追溯：${t.path}`, tall: true, body: box });
  }).catch((e) => toast(e.message));
}

export function openGitPanel() {
  const body = h("div", { class: "gitp" });
  let message = "";
  let busy = false;
  const offs = [];
  const sheet = openSheet({ title: "Git", tall: true, body, onClose: () => offs.forEach((f) => f()) });
  offs.push(runtime.on("git.changed", () => render()));

  const act = async (fn, okText) => {
    if (busy) return;
    busy = true;
    try { const r = await fn(); if (okText) toast(okText); return r; } catch (e) { toast(e.message); } finally { busy = false; render(); refreshGit(); }
  };

  async function resetTo(c) {
    openMenu(`回退到 ${c.hash}`, [
      { label: "软回退（保留文件与改动）", icon: "history", onClick: async () => {
        const ok = await confirmDialog({ title: `软回退到 ${c.hash}？`, message: "只移动当前分支指针。此版本之后的提交会变成已暂存改动，工作区文件保持不变。", confirmLabel: "软回退" });
        if (ok) act(() => runtime.git.reset({ hash: c.hash, mode: "soft" }), `已软回退到 ${c.hash}`);
      } },
      { label: "强制回退（恢复文件）", icon: "history", danger: true, onClick: async () => {
        const ok = await confirmDialog({ title: `强制回退到 ${c.hash}？`, message: "工作区中的已跟踪文件会恢复到这个版本；被覆盖或移除的内容会尽量进入 Diffusion 回收站。未提交修改可能不再留在工作区。", confirmLabel: "强制回退", danger: true });
        if (ok) act(() => runtime.git.reset({ hash: c.hash, mode: "hard", confirm: true }), `已强制回退到 ${c.hash}`);
      } },
    ]);
  }

  async function render() {
    let st;
    try { st = await runtime.git.status(); } catch (e) { clear(body); body.appendChild(h("p", { class: "muted", style: { padding: "12px" } }, e.message)); return; }
    const keepMsg = body.querySelector("textarea");
    if (keepMsg) message = keepMsg.value;
    clear(body);
    if (!st.is_repo) {
      body.appendChild(h("div", { class: "wcard" }, h("h3", null, "这个文件夹还不是 Git 仓库"), h("p", { class: "muted" }, "初始化之后，就可以在这里查看改动、提交和切换分支。"),
        h("button", { class: "btn filled", type: "button", onclick: () => act(() => runtime.git.init(), "已初始化仓库") }, "初始化仓库")));
      return;
    }
    const staged = st.files.filter((f) => f.index !== " " && f.index !== "?");
    const unstaged = st.files.filter((f) => f.index !== "?" && f.worktree !== " ");
    const untracked = st.files.filter((f) => f.index === "?");

    const branchBtn = h("button", { class: "chip", type: "button", onclick: async () => {
      const { branches } = await runtime.git.branches().catch(() => ({ branches: [] }));
      openMenu("切换分支", [
        ...branches.map((b) => ({ label: (b.current ? "✓ " : "") + b.name, icon: "branch", onClick: () => b.current || act(() => runtime.git.checkout({ name: b.name }), `已切换到 ${b.name}`) })),
        { label: "新建分支…", icon: "add", onClick: async () => { const n = await promptDialog({ title: "新建分支", label: "分支名", confirmLabel: "创建" }); if (n) act(() => runtime.git.checkout({ name: n, create: true }), `已创建并切换到 ${n}`); } },
      ]);
    } }, icon("branch", 16), h("span", null, st.branch || "（无分支）"));
    const sync = st.upstream ? h("span", { class: "muted" }, `↑${st.ahead} ↓${st.behind}`) : h("span", { class: "muted" }, "未关联远程");
    body.appendChild(h("div", { class: "gitbar" }, branchBtn, sync, h("div", { class: "spacer" }),
      h("button", { class: "btn small tonal", type: "button", onclick: () => act(() => runtime.git.pull(), "已拉取") }, "拉取"),
      h("button", { class: "btn small tonal", type: "button", onclick: () => act(() => runtime.git.push(), "已推送") }, "推送")));

    const row = (f, kind) => {
      const letter = f.index === "?" ? "U" : kind === "staged" ? f.index : f.worktree;
      const btns = [];
      if (kind === "staged") btns.push(h("button", { class: "btn text small", type: "button", onclick: (e) => { e.stopPropagation(); act(() => runtime.git.unstage({ paths: [f.path] })); } }, "取消暂存"));
      else btns.push(h("button", { class: "btn text small", type: "button", onclick: (e) => { e.stopPropagation(); act(() => runtime.git.stage({ paths: [f.path] })); } }, "暂存"));
      if (kind !== "staged") btns.push(h("button", { class: "btn text small danger", type: "button", onclick: async (e) => {
        e.stopPropagation();
        const isNew = kind === "untracked";
        if (await confirmDialog({ title: `丢弃 ${f.path} 的改动？`, message: isNew ? "这是新文件，它会被移到 Diffusion 回收站，可以在设置里恢复。" : "这个文件会恢复成上次提交时的样子，未提交的修改会丢失。", confirmLabel: "丢弃", danger: true })) act(() => runtime.git.discard({ path: f.path, confirm: true }), "已丢弃");
      } }, "丢弃"));
      return h("div", { class: "frow", role: "button", tabindex: "0", onclick: () => openDiff(f.path, kind === "staged") },
        h("span", { class: "gl", dataset: { l: letter }, title: LABEL[letter] || letter }, letter), h("span", { class: "fp" }, f.path), ...btns);
    };
    const group = (title, list, kind, extra) => list.length ? h("section", { class: "fgroup" }, h("h4", null, `${title}（${list.length}）`, extra || null), ...list.map((f) => row(f, kind))) : null;
    const stageAll = [...unstaged, ...untracked];
    append(body, [
      group("已暂存", staged, "staged"),
      group("未暂存", unstaged, "unstaged", stageAll.length ? h("button", { class: "btn text small", type: "button", onclick: () => act(() => runtime.git.stage({ paths: stageAll.map((f) => f.path) })) }, "全部暂存") : null),
      group("未跟踪", untracked, "untracked"),
      !st.files.length ? h("p", { class: "muted", style: { padding: "8px 4px" } }, "工作区很干净，没有未提交的改动。") : null]);

    const ta = h("textarea", { class: "text-field", rows: "2", placeholder: "提交说明", "aria-label": "提交说明" });
    ta.value = message;
    body.appendChild(h("div", { class: "commit" }, ta, h("button", { class: "btn filled", type: "button", disabled: !staged.length,
      onclick: () => { const m = ta.value.trim(); if (!m) return toast("请填写提交说明"); message = ""; act(() => runtime.git.commit({ message: m }), "已提交"); } }, `提交（${staged.length}）`)));
    body.appendChild(h("div", { style: { display: "flex", gap: "8px", margin: "8px 0", flexWrap: "wrap" } },
      stageAll.length ? h("button", { class: "btn tonal small", type: "button", onclick: () => act(() => runtime.git.stage({ paths: stageAll.map((f) => f.path) })) }, `全部暂存（${stageAll.length}）`) : null,
      h("button", { class: "btn outlined small", type: "button", onclick: openBlame }, "追溯当前文件")));

    try {
      const { commits } = await runtime.git.log({ limit: 20 });
      if (commits.length) body.appendChild(h("section", { class: "fgroup" }, h("h4", null, "最近的提交"),
        ...commits.map((c) => h("div", { class: "crow" }, h("span", { class: "hash" }, c.hash), h("span", { class: "subj" }, c.subject), h("span", { class: "muted meta" }, `${c.author} · ${c.date}`),
          h("button", { class: "btn text small reset-commit", type: "button", onclick: () => resetTo(c) }, "回退到这里")))));
    } catch { /* 还没有提交 */ }
  }
  render();
  return sheet;
}
