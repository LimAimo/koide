// Bridge client. Speaks the JSON protocol documented in docs/protocol.md.
//   rpc(method, params) -> Promise      on(event, fn) -> unsubscribe      status: offline | connecting | online

export class BridgeError extends Error {
  constructor(err) { super(err.message || "桥接服务出错"); this.code = err.code || "ERROR"; this.data = err.data || {}; }
}

export class Bridge {
  constructor() {
    this.ws = null;
    this.status = "offline";
    this.target = null;
    this.hello = null;
    this._id = 0;
    this._pending = new Map();
    this._handlers = new Map();
    this._statusHandlers = new Set();
    this._wantOnline = false;
    this._retry = 0;
    this._retryTimer = null;
    this._connectionGeneration = 0;
    this._cancelConnect = null;
  }

  onStatus(fn) { this._statusHandlers.add(fn); return () => this._statusHandlers.delete(fn); }
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this._handlers.get(event).delete(fn);
  }
  _emit(event, data) {
    for (const k of [event, "*"]) for (const fn of this._handlers.get(k) || []) { try { fn(data, event); } catch (e) { console.error(e); } }
  }
  _setStatus(s) { this.status = s; for (const fn of this._statusHandlers) fn(s); }

  /** Where might a Bridge be? The origin that served us first, then loopback, then remembered devices. */
  static candidates(remembered = []) {
    const out = [];
    if (/^https?:$/.test(location.protocol) && location.host) out.push({ host: location.hostname, port: Number(location.port) || (location.protocol === "https:" ? 443 : 80), tls: location.protocol === "https:" });
    out.push({ host: "127.0.0.1", port: 8765 });
    for (const r of remembered) out.push(r);
    const seen = new Set();
    return out.filter((t) => { const k = `${t.host}:${t.port}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /** Try each candidate quietly; resolves with the target that worked, or null (web-only mode). */
  async discover(remembered = []) {
    for (const t of Bridge.candidates(remembered)) {
      try { await this.connect(t, { timeout: 1500, quiet: true }); return t; } catch { /* next */ }
    }
    this._wantOnline = false;
    this._setStatus("offline");
    return null;
  }

  connect(target, { timeout = 5000, quiet = false } = {}) {
    this.close(true);
    const generation = this._connectionGeneration;
    this.target = target;
    this._wantOnline = true;
    this._setStatus("connecting");
    return new Promise((resolve, reject) => {
      const url = `${target.tls ? "wss" : "ws"}://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}/ws${target.token ? `?token=${encodeURIComponent(target.token)}` : ""}`;
      let settled = false, ws, timer;
      const current = () => generation === this._connectionGeneration;
      const currentSocket = () => current() && this.ws === ws;
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._cancelConnect === fail) this._cancelConnect = null;
        if (current()) {
          this.ws = null;
          this._rejectPending(why);
          this._detachSocket(ws);
          try { ws?.close(); } catch { /* ignore */ }
          if (quiet) this._wantOnline = false;
          this._setStatus("offline");
          if (!quiet) this._scheduleRetry();
        }
        reject(new Error(why));
      };
      this._cancelConnect = fail;
      try { ws = new WebSocket(url); } catch (e) { return fail(e.message); }
      this.ws = ws;
      timer = setTimeout(() => fail("连接超时"), timeout);
      ws.onopen = async () => {
        if (!currentSocket()) return;
        try {
          const hello = await this.rpc("hello");
          if (!currentSocket()) return;
          this.hello = hello;
          settled = true;
          clearTimeout(timer);
          if (this._cancelConnect === fail) this._cancelConnect = null;
          this._retry = 0;
          this._setStatus("online");
          this._emit("hello", this.hello);
          resolve(this.hello);
        } catch (e) { clearTimeout(timer); fail(e.message); }
      };
      ws.onmessage = (ev) => { if (currentSocket()) this._onMessage(ev.data); };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (!currentSocket()) return;
        clearTimeout(timer);
        if (!settled) return fail("无法连接");
        this.ws = null;
        this._detachSocket(ws);
        this._rejectPending("连接已断开");
        this._setStatus("offline");
        this._scheduleRetry();
      };
    });
  }

  _scheduleRetry() {
    if (!this._wantOnline || !this.target) return;
    const delay = Math.min(10000, 500 * 2 ** this._retry++);
    const generation = this._connectionGeneration, target = this.target;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      if (generation !== this._connectionGeneration || !this._wantOnline || this.status === "online") return;
      this._setStatus("connecting");
      this.connect(target, { timeout: 4000 }).catch(() => {});
    }, delay);
  }

  close(silent = false) {
    this._wantOnline = false;
    clearTimeout(this._retryTimer);
    this._connectionGeneration++;
    const ws = this.ws;
    this.ws = null;
    const cancel = this._cancelConnect;
    this._cancelConnect = null;
    cancel?.("连接已取消");
    this._rejectPending("连接已断开");
    this._detachSocket(ws);
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    if (!silent) this._setStatus("offline");
  }

  _detachSocket(ws) {
    if (ws) ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  }

  _rejectPending(message) {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const p of pending) p.reject(new Error(message));
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "event") return this._emit(msg.event, msg.data);
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    if (msg.type === "result") p.resolve(msg.result);
    else p.reject(new BridgeError(msg.error || {}));
  }

  rpc(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("尚未连接桥接服务"));
      const id = ++this._id;
      const t = setTimeout(() => { this._pending.delete(id); reject(new Error(`${method} 请求超时`)); }, timeoutMs);
      this._pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this.ws.send(JSON.stringify({ type: "rpc", id, method, params })); }
      catch (error) { this._pending.delete(id); clearTimeout(t); reject(error); }
    });
  }

  /** Pair with a LAN Bridge: exchange the one-time code for a device token. */
  static async pair({ host, port, tls }, code, name) {
    const res = await fetch(`${tls ? "https" : "http"}://${host}:${port}/api/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `配对失败（${res.status}）`);
    return body.token;
  }
}
