/**
 * Tauri adapter. It contains no localhost/WebSocket assumptions: every call goes directly to
 * the Rust process through Tauri IPC and every domain event comes from the native event bus.
 */
export class NativeRuntimeAdapter {
  constructor(tauri = globalThis.__TAURI__) {
    if (!tauri?.core?.invoke || !tauri?.event?.listen) throw new Error("Tauri runtime is unavailable");
    this.tauri = tauri;
    this.kind = "native";
    this.status = "online";
    this.handlers = new Map();
    this.statusHandlers = new Set();
    this.unlisten = null;
    this.ready = this._bindEvents();
  }

  async _bindEvents() {
    this.unlisten = await this.tauri.event.listen("diffusion://event", ({ payload }) => {
      if (!payload || typeof payload.event !== "string") return;
      for (const fn of this.handlers.get(payload.event) || []) {
        try { fn(payload.data || {}); } catch (e) { console.error(e); }
      }
      for (const fn of this.handlers.get("*") || []) {
        try { fn(payload.data || {}, payload.event); } catch (e) { console.error(e); }
      }
    });
  }

  onStatus(fn) {
    this.statusHandlers.add(fn);
    queueMicrotask(() => fn("online"));
    return () => this.statusHandlers.delete(fn);
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  async call(method, params = {}) {
    await this.ready;
    try {
      return await this.tauri.core.invoke("runtime_call", { method, params });
    } catch (e) {
      if (typeof e === "object" && e && e.message) throw Object.assign(new Error(e.message), { code: e.code || "NATIVE_ERROR", data: e.data || {} });
      throw new Error(String(e));
    }
  }

  async discover() {
    const hello = await this.call("hello");
    queueMicrotask(() => {
      for (const fn of this.handlers.get("hello") || []) fn(hello);
    });
    return { native: true };
  }

  async connect() { return this.discover(); }
  close() {}
  pair() { throw new Error("本机原生模式不需要配对；请在启用远程访问后使用 Remote Runtime"); }
}
