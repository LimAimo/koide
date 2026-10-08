// 启动逻辑使用同源模块，允许 Bridge 保持禁止内联脚本的内容安全策略。
let diagnostic = "";
const show = (value, meta = {}) => {
  const box = document.getElementById("boot-fallback");
  const out = document.getElementById("boot-error");
  if (!box || !out) return;
  const detail = String(value && (value.stack || value.message) || value || "未知启动错误");
  const where = meta.filename ? `${meta.filename}:${meta.lineno || "?"}:${meta.colno || "?"}` : "";
  diagnostic = ["Koide 启动失败", where, detail, `URL: ${location.href}`, `UA: ${navigator.userAgent}`].filter(Boolean).join("\n");
  out.textContent = diagnostic;
  box.hidden = false;
};
window.__KOIDE_BOOT_OK__ = false;
window.__KOIDE_SHOW_BOOT_ERROR__ = show;
window.addEventListener("error", (event) => show(event.error || event.message, event));
window.addEventListener("unhandledrejection", (event) => show(event.reason));
setTimeout(() => { if (!window.__KOIDE_BOOT_OK__) show("主界面未在 8 秒内完成启动。请复制诊断信息反馈。"); }, 8000);
document.getElementById("boot-copy")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(diagnostic); }
  catch { document.getElementById("boot-error")?.focus?.(); }
});

async function start() {
  if (location.protocol === "file:") throw new Error("请通过 Koide 原生应用或 HTTP 服务启动，不能使用 file:// 打开。");
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    try {
      const cacheKeys = "caches" in window ? await caches.keys() : [];
      const registrations = await navigator.serviceWorker.getRegistrations();
      const ours = registrations.filter((registration) => {
        const worker = registration.active || registration.waiting || registration.installing;
        try { return worker && new URL(worker.scriptURL).pathname.endsWith("/sw.js"); }
        catch { return false; }
      });
      if (cacheKeys.some((key) => key.startsWith("dfx-shell-")) || ours.length || navigator.serviceWorker.controller) {
        await Promise.all(ours.map((registration) => registration.unregister()));
        await Promise.all(cacheKeys.filter((key) => key.startsWith("dfx-shell-")).map((key) => caches.delete(key)));
        if (navigator.serviceWorker.controller && !sessionStorage.getItem("koide-sw-cleaned")) {
          sessionStorage.setItem("koide-sw-cleaned", "1");
          location.reload();
          return;
        }
      }
      sessionStorage.removeItem("koide-sw-cleaned");
    } catch (error) { console.warn("旧版离线缓存清理失败", error); }
  }
  await import("./main.js");
}
start().catch(show);
