// 安全的 Markdown 渲染器：不使用 innerHTML，模型输出只能生成受控 DOM 节点。
// 覆盖 IDE 对话里常用的 CommonMark/GFM：标题、段落、粗斜体、删除线、链接、行内代码、
// 围栏/缩进代码块、引用、无序/有序/任务列表、分隔线、Setext 标题与表格。

import { h, toast } from "./dom.js";

const safeHref = (raw) => {
  const v = String(raw || "").trim();
  if (/^(https?:|mailto:)/i.test(v)) return v;
  return null;
};

function textNode(s) { return document.createTextNode(s); }

function inline(src) {
  const out = [], s = String(src || "");
  let i = 0, buf = "";
  const flush = () => { if (buf) { out.push(textNode(buf)); buf = ""; } };
  const pushWrapped = (tag, inner, props = null) => { flush(); out.push(h(tag, props, ...inline(inner))); };

  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push(h("code", null, s.slice(i + 1, end))); i = end + 1; continue; }
    }
    if (s.startsWith("![", i)) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/.exec(s.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[2]);
        out.push(h(href ? "a" : "span", href ? { href, target: "_blank", rel: "noopener noreferrer", class: "md-image-link" } : { class: "md-image-link" }, `🖼 ${m[1] || m[2]}`));
        i += m[0].length; continue;
      }
    }
    if (s[i] === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/.exec(s.slice(i));
      if (m) {
        flush(); const href = safeHref(m[2]);
        out.push(h(href ? "a" : "span", href ? { href, target: "_blank", rel: "noopener noreferrer" } : null, ...inline(m[1])));
        i += m[0].length; continue;
      }
    }
    const auto = /^(https?:\/\/[^\s<]+)/i.exec(s.slice(i));
    if (auto) {
      flush(); out.push(h("a", { href: auto[1], target: "_blank", rel: "noopener noreferrer" }, auto[1]));
      i += auto[1].length; continue;
    }
    if (s.startsWith("**", i) || s.startsWith("__", i)) {
      const mark = s.slice(i, i + 2), end = s.indexOf(mark, i + 2);
      if (end > i + 2) { pushWrapped("strong", s.slice(i + 2, end)); i = end + 2; continue; }
    }
    if (s.startsWith("~~", i)) {
      const end = s.indexOf("~~", i + 2);
      if (end > i + 2) { pushWrapped("del", s.slice(i + 2, end)); i = end + 2; continue; }
    }
    if ((s[i] === "*" || s[i] === "_") && s[i + 1] !== s[i]) {
      const end = s.indexOf(s[i], i + 1);
      if (end > i + 1) { pushWrapped("em", s.slice(i + 1, end)); i = end + 1; continue; }
    }
    buf += s[i++];
  }
  flush();
  return out;
}

const appendInline = (el, text) => { for (const n of inline(text)) el.appendChild(n); return el; };

function codeBlock(lang, code) {
  const c = h("code", lang ? { class: `language-${lang.replace(/[^a-z0-9_+-]/gi, "")}` } : null, code.replace(/\n$/, ""));
  const pre = h("pre", null, c);
  pre.addEventListener("dblclick", () => navigator.clipboard?.writeText(code).then(() => toast("已复制")));
  return pre;
}

function tableBlock(lines) {
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
  const heads = cells(lines[0]);
  const table = h("table", null, h("thead", null, h("tr", null, heads.map((x) => appendInline(h("th"), x)))));
  const tbody = h("tbody");
  for (const line of lines.slice(2)) tbody.appendChild(h("tr", null, cells(line).map((x) => appendInline(h("td"), x))));
  table.appendChild(tbody);
  return h("div", { class: "md-table-wrap" }, table);
}

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment ? document.createDocumentFragment() : h("div");
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1], lang = fence[2].trim().split(/\s+/)[0] || "", buf = [];
      i++;
      const close = new RegExp(`^\\s*${marker.replace(/([~`])/g, "\\$1")}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) i++;
      frag.appendChild(codeBlock(lang, buf.join("\n")));
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
        const cur = lines[i++];
        buf.push(cur.startsWith("\t") ? cur.slice(1) : cur.slice(4));
      }
      while (buf.length && !buf.at(-1)) buf.pop();
      frag.appendChild(codeBlock("", buf.join("\n")));
      continue;
    }

    if (i + 1 < lines.length && line.trim() && /^\s*(=+|-+)\s*$/.test(lines[i + 1])) {
      const level = /=/.test(lines[i + 1]) ? 1 : 2;
      frag.appendChild(appendInline(h(`h${level}`), line.trim()));
      i += 2;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { frag.appendChild(appendInline(h(`h${heading[1].length}`), heading[2])); i++; continue; }
    if (/^\s{0,3}((\*|-|_)\s*){3,}$/.test(line)) { frag.appendChild(h("hr")); i++; continue; }

    if (i + 1 < lines.length && /\|/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const block = [line, lines[i + 1]]; i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) block.push(lines[i++]);
      frag.appendChild(tableBlock(block)); continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      const box = h("blockquote"); box.appendChild(renderMarkdown(q.join("\n"))); frag.appendChild(box); continue;
    }

    const li = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      const ordered = /^\d/.test(li[1]), list = h(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[i]);
        if (!m || /^\d/.test(m[1]) !== ordered) break;
        let txt = m[2], task = /^\[([ xX])\]\s+/.exec(txt);
        const item = h("li");
        if (task) {
          item.classList.add("task-item");
          const cb = h("input", { type: "checkbox", disabled: true }); cb.checked = task[1].toLowerCase() === "x";
          item.appendChild(cb); txt = txt.slice(task[0].length);
        }
        appendInline(item, txt); list.appendChild(item); i++;
      }
      frag.appendChild(list); continue;
    }

    const para = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*([-+*]|\d+[.)])\s+/.test(lines[i]) && !/^\s{0,3}((\*|-|_)\s*){3,}$/.test(lines[i])) {
      para.push(lines[i].trim()); i++;
    }
    const p = h("p");
    para.forEach((t, n) => { if (n) p.appendChild(document.createElement("br")); appendInline(p, t); });
    frag.appendChild(p);
  }
  return frag;
}
