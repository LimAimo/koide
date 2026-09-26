import { Bridge } from "../../bridge.js";

/**
 * Migration-only adapter for the v0.7 Python Bridge.
 * New UI code must never import Bridge directly; this file is the quarantine boundary.
 */
export class BridgeRuntimeAdapter {
  constructor() { this.bridge = new Bridge(); this.kind = "bridge"; }
  get status() { return this.bridge.status; }
  onStatus(fn) { return this.bridge.onStatus(fn); }
  on(event, fn) { return this.bridge.on(event, fn); }
  async call(method, params = {}, timeoutMs) {
    const result = await this.bridge.rpc(method, params, timeoutMs);
    if (method === "fs.export" && result?.url && !/^https?:\/\//i.test(result.url)) {
      const t = this.bridge.target;
      if (t) {
        const host = t.host.includes(":") ? `[${t.host}]` : t.host;
        return { ...result, url: `${t.tls ? "https" : "http"}://${host}:${t.port}${result.url}` };
      }
    }
    return result;
  }
  discover(remembered = []) { return this.bridge.discover(remembered); }
  connect(target, options) { return this.bridge.connect(target, options); }
  close(silent = false) { return this.bridge.close(silent); }
  pair(target, code, name) { return Bridge.pair(target, code, name); }
}
