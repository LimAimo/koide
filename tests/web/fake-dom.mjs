// A small fake DOM, just enough to boot our real UI code in Node. It is not a browser and does no layout:
// lines are 20px tall and glyph cells 8px wide so measured positions are predictable.

class FNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; return s[s.indexOf(this) + 1] || null; }
  appendChild(n) {
    if (n.nodeType === 11) { for (const c of [...n.childNodes]) this.appendChild(c); return n; }
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.childNodes.push(n); return n;
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  append(...ns) { for (const n of ns) this.appendChild(n && typeof n === "object" && n.nodeType ? n : new FText(String(n))); }   // 与浏览器一致：null 会变成文字 "null"
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
}

class FText extends FNode {
  constructor(t) { super(); this.nodeType = 3; this.data = t; }
  get length() { return this.data.length; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = v; }
}

export const anims = [];

function makeStyle() {
  const props = {};
  return new Proxy({}, {
    get(t, k) {
      if (k === "setProperty") return (n, v) => { props[n] = String(v); };
      if (k === "getPropertyValue") return (n) => props[n] ?? "";
      if (k === "removeProperty") return (n) => { delete props[n]; };
      if (k === "_props") return props;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

// ---- tiny selector engine: tag, .class, [attr], [attr="v"], descendant (space) and child (>) ---------
function parseCompound(s) {
  const c = { tag: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) c.tag = m[1] === "*" ? null : m[1].toUpperCase();
    else if (m[2]) c.classes.push(m[2]);
    else c.attrs.push([m[3], m[4] ?? m[5] ?? m[6]]);
  }
  return c;
}
function matchCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  const cls = el.className.split(/\s+/);
  if (!c.classes.every((k) => cls.includes(k))) return false;
  return c.attrs.every(([k, v]) => {
    const val = k.startsWith("data-") ? el.dataset[k.slice(5).replace(/-(\w)/g, (_, x) => x.toUpperCase())] ?? el.attrs[k] : el.attrs[k];
    return v === undefined ? val !== undefined : String(val) === v;
  });
}
function selectAll(root, selector) {
  const out = new Set();
  for (const part of selector.split(",")) {
    const toks = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
    const steps = [];
    let comb = " ";
    for (const t of toks) { if (t === ">") comb = ">"; else { steps.push({ c: parseCompound(t), comb }); comb = " "; } }
    const test = (el, i) => {
      if (!matchCompound(el, steps[i].c)) return false;
      if (i === 0) return true;
      if (steps[i].comb === ">") return el.parentNode && el.parentNode.nodeType === 1 && test(el.parentNode, i - 1);
      for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (test(p, i - 1)) return true;
      return false;
    };
    const walk = (n) => { for (const ch of n.children) { if (test(ch, steps.length - 1)) out.add(ch); walk(ch); } };
    walk(root);
  }
  return [...out];
}

class FEl extends FNode {
  constructor(tag) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.style = makeStyle(); this.attrs = {}; this.className = "";
    this.listeners = {}; this.dataset = {}; this.scrollTop = 0; this.scrollLeft = 0; this.clientHeight = 600;
    this.value = ""; this.checked = false; this.selectionStart = 0; this.selectionEnd = 0; this.readOnly = false; this.hidden = false;
    this.offsetWidth = 300; this.offsetHeight = 300; this.scrollHeight = 600;
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    const write = (a) => { self.className = a.join(" "); };
    this.classList = {
      add: (...c) => { const a = list(); for (const x of c) if (!a.includes(x)) a.push(x); write(a); },
      remove: (...c) => write(list().filter((x) => !c.includes(x))),
      contains: (c) => list().includes(c),
      toggle: (c, on) => { const has = list().includes(c); const want = on ?? !has; if (want && !has) write([...list(), c]); if (!want && has) write(list().filter((x) => x !== c)); return want; },
    };
  }
  get ownerDocument() { return globalThis.document; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes = []; if (v !== "") this.appendChild(new FText(String(v))); }
  get id() { return this.attrs.id; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); if (k === "value") this.value = String(v); if (k === "hidden") this.hidden = true; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatchEvent(e) { try { e.target ||= this; } catch { /* native Event: target is read-only */ } for (const f of this.listeners[e.type] || []) f(e); return true; }
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  select() {}
  scrollIntoView() {}
  setPointerCapture() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  setRangeText(t, a, b, mode) { this.value = this.value.slice(0, a) + t + this.value.slice(b); if (mode === "end") this.selectionStart = this.selectionEnd = a + t.length; }
  querySelector(s) { return selectAll(this, s)[0] || null; }
  querySelectorAll(s) { return selectAll(this, s); }
  getBoundingClientRect() {
    if (this.className.split(/\s+/).includes("ln") && this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      return { left: 0, top: i * 20, width: 100, height: 20 };
    }
    if (this.tagName === "SPAN" && this.textContent === "0000000000") return { left: 0, top: 0, width: 80, height: 20 };
    return { left: 0, top: 0, width: 300, height: 40 };
  }
  animate(keyframes, opts) {
    const a = { keyframes, opts, el: this, finished: Promise.resolve(), cancel() { this.cancelled = true; } };
    anims.push(a);
    return a;
  }
}

class FFragment extends FNode { constructor() { super(); this.nodeType = 11; } }

export function installFakeDom({ width = 400, height = 800 } = {}) {
  anims.length = 0;
  const winHandlers = {}, docHandlers = {};
  const reg = (m) => (t, fn) => { (m[t] ||= []).push(fn); };
  const fire = (m, t, e = {}) => (m[t] || []).forEach((f) => f({ type: t, ...e }));
  const store = new Map();

  const doc = {
    createElement: (t) => new FEl(t),
    createElementNS: (_ns, t) => new FEl(t),
    createTextNode: (t) => new FText(String(t)),
    createDocumentFragment: () => new FFragment(),
    createRange: () => ({ s: 0, e: 0, setStart(_n, o) { this.s = o; }, setEnd(_n, o) { this.e = o; },
      getBoundingClientRect() { return { left: this.s * 8, top: 0, width: (this.e - this.s) * 8, height: 20 }; } }),
    execCommand: () => false,
    body: new FEl("body"),
    documentElement: new FEl("html"),
    readyState: "complete",
    fullscreenElement: null,
    getElementById(id) { return selectAll(this.body, "*").find((e) => e.attrs.id === id) || null; },
    querySelector: () => null,
    addEventListener: reg(docHandlers),
    defaultView: null,
  };
  const win = {
    innerWidth: width, innerHeight: height, visualViewport: undefined,
    addEventListener: reg(winHandlers),
    removeEventListener: (t, fn) => { winHandlers[t] = (winHandlers[t] || []).filter((f) => f !== fn); },
    getComputedStyle: (el) => ({ paddingLeft: "0px", getPropertyValue: (n) => (el && el.style ? el.style.getPropertyValue(n) : "") }),
  };
  doc.defaultView = win;
  const historyStack = [0];
  Object.assign(globalThis, {
    document: doc, window: win,
    innerWidth: width, innerHeight: height,
    getComputedStyle: win.getComputedStyle,
    matchMedia: (q) => ({ matches: false, media: q }),
    requestAnimationFrame: (f) => setTimeout(() => f(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    history: {
      pushState() { historyStack.push(historyStack.length); },
      back() { historyStack.pop(); setTimeout(() => fire(winHandlers, "popstate"), 0); },
    },
    addEventListener: win.addEventListener,
  });
  return { doc, win, fireWindow: (t, e) => fire(winHandlers, t, e), fireDoc: (t, e) => fire(docHandlers, t, e) };
}

export const $$ = (root, sel) => selectAll(root, sel);
