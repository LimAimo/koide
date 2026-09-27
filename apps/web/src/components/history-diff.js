import { h } from "./dom.js";
import { lineDiff } from "../services/history-diff.js";

export function diffStats(diff) {
  return h("span", { class: "diff-stats", "aria-label": `新增 ${diff.added} 行，删除 ${diff.deleted} 行` },
    h("span", { class: "diff-added" }, `+${diff.added}`), h("span", { class: "diff-deleted" }, `−${diff.deleted}`));
}
const range = (value) => !value ? "无" : value[0] === value[1] ? `${value[0]}` : `${value[0]}–${value[1]}`;

export function createHistoryDiff(data) {
  if (data.text_available === false) return h("p", { class: "muted" }, "这是二进制文件或超出文本预览限制，无法显示行差异。");
  const diff = lineDiff(data.before, data.after);
  if (diff.limited) return h("p", { class: "muted" }, "改动较大，已省略行级比较。仍可查看快照重播。");
  const body = h("div", { class: "history-diff" }, diffStats(diff));
  if (!diff.hunks.length) {
    body.appendChild(h("p", { class: "muted" }, data.before == null && data.after != null ? "创建了空文件。" : data.after == null && data.before != null ? "删除了空文件。" : "没有文本行变化。"));
    return body;
  }
  const nav = h("nav", { class: "diff-hunks", "aria-label": "跳转到修改区域" });
  body.appendChild(nav);
  let remaining = 1200;
  for (const [index, hunk] of diff.hunks.entries()) {
    if (!remaining) break;
    const label = `${{ insert: "新增", delete: "删除", change: "修改" }[hunk.kind]} · 原 ${range(hunk.oldRange)} → 新 ${range(hunk.newRange)}`;
    const section = h("section", { class: "diff-hunk", tabindex: "-1", "aria-label": label }, h("h4", null, label));
    nav.appendChild(h("button", { class: "btn text small", type: "button", onclick: () => { section.scrollIntoView({ block: "start" }); section.focus({ preventScroll: true }); } }, `区域 ${index + 1}`));
    const rows = h("div", { class: "diff-lines", role: "table", "aria-label": "原行号、新行号、改动内容" });
    const shown = hunk.rows.slice(0, remaining); remaining -= shown.length;
    for (const row of shown) {
      rows.appendChild(h("div", { class: `diff-line ${row.kind}`, role: "row" },
        h("span", { class: "diff-number", role: "cell" }, row.oldLine ?? ""),
        h("span", { class: "diff-number", role: "cell" }, row.newLine ?? ""),
        h("span", { class: "diff-sign", role: "cell" }, row.kind === "insert" ? "+" : row.kind === "delete" ? "−" : " "),
        h("code", { role: "cell" }, row.text.length > 4000 ? row.text.slice(0, 4000) + "…（该行过长）" : row.text,
          row.noNewline && row.kind !== "equal" ? h("small", { class: "diff-eof" }, "无末尾换行") : null)));
    }
    section.appendChild(rows); body.appendChild(section);
  }
  if (diff.hunks.reduce((n, hunk) => n + hunk.rows.length, 0) > 1200) body.appendChild(h("p", { class: "muted" }, "已显示前 1200 行预览；上方增删统计包含全部改动。"));
  return body;
}
