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
  call(method, params = {}, timeoutMs) { return this.bridge.rpc(method, params, timeoutMs); }
  discover(remembered = []) { return this.bridge.discover(remembered); }
  connect(target, options) { return this.bridge.connect(target, options); }
  close(silent = false) { return this.bridge.close(silent); }
  pair(target, code, name) { return Bridge.pair(target, code, name); }
}
