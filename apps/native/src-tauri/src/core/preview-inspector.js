(() => {
  "use strict";
  const token = __TOKEN_JSON__;
  const prefix = "/" + token;
  const send = (event, data) => parent.postMessage({ type: "koide.preview", token, event, data }, "*");
  const stringify = value => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); send("console", { level, text: args.map(stringify).join(" ").slice(0, 4000), time: Date.now() }); };
  }
  addEventListener("error", event => send("error", { message: String(event.message || "资源加载失败").slice(0, 4000), filename: String(event.filename || ""), line: event.lineno || 0, column: event.colno || 0 }));
  addEventListener("unhandledrejection", event => send("error", { message: stringify(event.reason).slice(0, 4000) }));
  const rewrite = url => typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith(prefix + "/") ? prefix + url : url;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, options) => originalFetch(typeof url === "string" ? rewrite(url) : url, options);
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return originalOpen.call(this, method, rewrite(url), ...rest); };
  let picking = false, mark;
  const selector = element => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    for (let node = element; node && parts.length < 5; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length) part += "." + Array.from(node.classList).slice(0, 2).map(CSS.escape).join(".");
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  addEventListener("message", event => {
    if (event.source !== parent || !event.data || event.data.type !== "koide.preview.control" || event.data.token !== token) return;
    picking = !!event.data.inspect;
    if (!picking && mark) mark.remove();
  });
  addEventListener("pointermove", event => {
    if (!picking || !event.target || event.target === mark) return;
    const rect = event.target.getBoundingClientRect();
    if (!mark) { mark = document.createElement("div"); mark.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #59d6c9;background:#59d6c922;box-sizing:border-box"; }
    document.documentElement.append(mark);
    Object.assign(mark.style, { left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
  }, true);
  addEventListener("click", event => {
    if (!picking) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const element = event.target, rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    send("element", { selector: selector(element), tag: element.tagName.toLowerCase(), text: String(element.textContent || "").slice(0, 500), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles: { color: style.color, background: style.backgroundColor, fontSize: style.fontSize, padding: style.padding, gap: style.gap } });
  }, true);
  addEventListener("DOMContentLoaded", () => send("console", { level: "info", text: "预览已连接；当前代理为只读，修改后可点击刷新", time: Date.now() }));
})();
