// Small, dependency-free highlighter. Per line only (no multi-line comment/string state), which is the
// price of instant, allocation-light rendering on phones. Returns segments [{start, end, cls}].

const KW = new Set(("abstract and as assert async await break case catch class const continue def default defer del delete do elif else " +
  "enum except export extends false final finally fn for from func function go goto if impl implements import in instanceof interface is lambda " +
  "let match mod mut namespace new nil none not null of or override package pass private protected pub public raise return self static struct " +
  "super switch this throw trait true try type typeof use val var void when where while with yield").split(" "));
const HASH_COMMENT = new Set(["py", "sh", "bash", "rb", "yml", "yaml", "toml", "conf", "ini", "r", "pl", "gradle-properties"]);
const PLAIN = new Set(["txt", "md", "log", ""]);

export function langOf(path = "") {
  const m = /\.([A-Za-z0-9-]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

export function highlightLine(line, lang = "") {
  if (PLAIN.has(lang) || line.length > 600) return [];
  const segs = [];
  const hash = HASH_COMMENT.has(lang);
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if ((c === "/" && line[i + 1] === "/" && lang !== "css") || (hash && c === "#") || (c === "-" && line[i + 1] === "-" && (lang === "sql" || lang === "lua")) ||
        (c === "/" && line[i + 1] === "*")) {
      segs.push({ start: i, end: n, cls: "tk-com" });
      break;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + 1);
      segs.push({ start: i, end: j, cls: "tk-str" });
      i = j;
      continue;
    }
    if (/\d/.test(c) && !/[\w$]/.test(line[i - 1] || "")) {
      let j = i + 1;
      while (j < n && /[\d._xXa-fA-F]/.test(line[j])) j++;
      segs.push({ start: i, end: j, cls: "tk-num" });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let cls = null;
      if (KW.has(word)) cls = "tk-kw";
      else if (line[j] === "(") cls = "tk-fn";
      else if (/^[A-Z][A-Za-z0-9]*$/.test(word) && word.length > 1) cls = "tk-type";
      if (cls) segs.push({ start: i, end: j, cls });
      i = j;
      continue;
    }
    i++;
  }
  return segs;
}

/** Fill `el` with text[start,end) coloured by segs (segment offsets are relative to the full line). */
export function fillColoured(doc, el, line, start, end, segs) {
  let pos = start;
  const put = (s, e, cls) => {
    if (e <= s) return;
    if (cls) { const sp = doc.createElement("span"); sp.className = cls; sp.textContent = line.slice(s, e); el.appendChild(sp); }
    else el.appendChild(doc.createTextNode(line.slice(s, e)));
  };
  for (const sg of segs) {
    if (sg.end <= start || sg.start >= end) continue;
    const s = Math.max(sg.start, start), e = Math.min(sg.end, end);
    put(pos, s, null);
    put(s, e, sg.cls);
    pos = e;
  }
  put(pos, end, null);
}
