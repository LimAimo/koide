// Only observable DOM/CSS and explicitly registered component state, never guessed closures.
const origins = new WeakMap();
export function registerElement(element, source, handlers = {}) { origins.set(element, { source, handlers }); }
export function registerComponent(element, descriptor) { origins.set(element, { ...origins.get(element), ...descriptor }); }
export function creationSource() {
  const stack = new Error().stack || "";
  const match = stack.split("\n").find((line) => /\/src\//.test(line) && !/\/(dom|inspection)\.js/.test(line));
  const found = match?.match(/(\/src\/[^\s)]+?):(\d+):(\d+)/);
  return found ? { path: `apps/web${found[1]}`, line: Number(found[2]), column: Number(found[3]) } : null;
}
export function elementKey(element) {
  if (element.id) return `#${element.id}`;
  if (element.dataset?.inspectKey) return `[data-inspect-key="${element.dataset.inspectKey}"]`;
  const path = []; let el = element;
  for (let depth = 0; el?.tagName && depth < 7; depth++, el = el.parentElement) {
    const siblings = el.parentElement ? [...el.parentElement.children] : [el];
    path.unshift(`${el.tagName.toLowerCase()}:nth-child(${siblings.indexOf(el) + 1})`);
    if (el.parentElement?.id) { path.unshift(`#${el.parentElement.id}`); break; }
  }
  return path.join(" > ");
}
export function inspectElement(element) {
  const doc = element.ownerDocument, win = doc.defaultView, rect = element.getBoundingClientRect(), computed = win.getComputedStyle(element);
  const registered = {};
  for (let owner = element; owner; owner = owner.parentElement) {
    const record = origins.get(owner); if (!record) continue;
    for (const key of ["source", "handlers", "component", "state"]) if (!registered[key] && record[key]) registered[key] = record[key];
  }
  const rules = [], inaccessible = [];
  function visit(items, source) {
    for (const rule of items) {
      if (rule.conditionText && rule.type === 4 && !win.matchMedia(rule.conditionText).matches) continue;
      if (rule.selectorText) { try { if (element.matches(rule.selectorText)) rules.push({ selector: rule.selectorText, declarations: rule.style.cssText, source }); } catch { /* unsupported pseudo selector */ } }
      if (rule.cssRules) visit(rule.cssRules, source);
    }
  }
  for (const sheet of doc.styleSheets) { try { visit(sheet.cssRules, sheet.href || "内联样式"); } catch { inaccessible.push(sheet.href || "跨域样式"); } }
  const styles = {}; for (const name of ["display", "position", "font-size", "color", "background-color", "padding", "margin", "gap", "transform", "transition", "animation", "overflow", "border-radius"]) styles[name] = computed.getPropertyValue(name);
  let state = null; try { state = registered?.state?.() ?? null; } catch { state = { error: "组件状态无法读取" }; }
  return { selector: elementKey(element), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 120), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    component: registered?.component || null, source: registered?.source || (element.dataset.source ? { path: element.dataset.source, line: Number(element.dataset.line) || 1 } : null),
    handlers: registered?.handlers || {}, state, computed: styles, css: rules.slice(-40), inaccessible_stylesheets: inaccessible, captured_at: Date.now(), viewport: { width: win.innerWidth, height: win.innerHeight } };
}
export function startInspector(onSelect, doc = document) {
  let active = true, last = null, previous = "";
  const control = doc.createElement("button"); control.textContent = "取消检查"; control.dataset.koideInspectorControls = "true";
  control.style.cssText = "position:fixed;right:16px;bottom:24px;z-index:2147483647;min-height:44px;padding:8px 16px;border-radius:24px;background:#173f7a;color:white;border:1px solid white;font:14px sans-serif";
  doc.body.appendChild(control);
  const restore = () => { if (last) last.style.outline = previous; last = null; };
  const cancel = () => { if (!active) return; active = false; restore(); control.remove(); doc.removeEventListener("pointermove", move, true); doc.removeEventListener("click", select, true); doc.removeEventListener("keydown", key, true); };
  const move = (event) => { if (event.target.closest?.("[data-koide-inspector-controls]")) return; if (event.target === last) return; restore(); last = event.target; previous = last.style.outline; last.style.outline = "2px solid #4d8dff"; };
  const select = (event) => { if (event.target.closest?.("[data-koide-inspector-controls]")) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; } event.preventDefault(); event.stopImmediatePropagation(); const target = event.target; cancel(); onSelect(inspectElement(target)); };
  const key = (event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
  doc.addEventListener("pointermove", move, true); doc.addEventListener("click", select, true); doc.addEventListener("keydown", key, true);
  return cancel;
}
export function layoutSnapshot(doc = document) {
  const win = doc.defaultView, rows = [];
  for (const el of doc.querySelectorAll("button,input,textarea,select,[role],header,main,nav,aside,.panel,.appbar,.composer")) {
    if (el.closest("#overlay-root,.engineering-preview-tools") || rows.length >= 300) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const s = win.getComputedStyle(el);
    rows.push({ key: elementKey(el), x: r.x, y: r.y, width: r.width, height: r.height, overflow: el.scrollWidth > el.clientWidth + 2 && ["hidden", "clip"].includes(s.overflowX), text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80) });
  }
  return { viewport: { width: win.innerWidth, height: win.innerHeight, dpr: win.devicePixelRatio }, theme: doc.documentElement.dataset.theme || win.getComputedStyle(doc.documentElement).colorScheme, nodes: rows, captured_at: Date.now() };
}
/** Optional preview integration; the project explicitly grants one Koide origin. */
export function installInspectorBridge(allowedOrigin) {
  const target = new URL(allowedOrigin).origin;
  let stop = null;
  const listener = (event) => {
    if (event.origin !== target || event.source !== window.parent || event.data?.channel !== "koide-inspector" || typeof event.data.nonce !== "string") return;
    const reply = (kind, value) => event.source.postMessage({ channel: "koide-inspector", nonce: event.data.nonce, kind, value }, target);
    if (event.data.action === "inspect") { stop?.(); stop = startInspector((value) => reply("element", value)); }
    if (event.data.action === "measure") reply("layout", layoutSnapshot());
    if (event.data.action === "stop") { stop?.(); stop = null; }
  };
  window.addEventListener("message", listener);
  return () => { stop?.(); window.removeEventListener("message", listener); };
}
