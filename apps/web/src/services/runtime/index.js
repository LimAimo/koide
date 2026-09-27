import { BridgeRuntimeAdapter } from "./adapters/bridge-runtime.js";
import { NativeRuntimeAdapter } from "./adapters/native-runtime.js";

const nativeAvailable = () => !!globalThis.__TAURI__?.core?.invoke;

export function createRuntime(adapter = nativeAvailable() ? new NativeRuntimeAdapter() : new BridgeRuntimeAdapter()) {
  const call = (method, params, timeoutMs) => adapter.call(method, params, timeoutMs);
  const empty = () => ({});
  const children = new Set();
  adapter.on("agent.started", (data) => { if (data.parent_task_id && data.task_id) { children.add(data.task_id); if (children.size > 256) children.delete(children.values().next().value); } });
  const isolated = new Set(["agent.started","agent.status","agent.tool","agent.message","agent.reasoning","agent.turn_end","agent.done","fs.changed","terminal.start","terminal.output","terminal.exit"]);
  const api = {
    kind: adapter.kind,
    get status() { return adapter.status; },
    onStatus: (fn) => adapter.onStatus(fn),
    on: (event, fn) => adapter.on(event, (data) => { if (isolated.has(event) && (data?.parent_task_id || children.has(data?.task_id))) return; fn(data); }),
    onAll: (event, fn) => adapter.on(event, fn),
    discover: (remembered) => adapter.discover(remembered),
    connect: (target, options) => adapter.connect(target, options),
    close: (silent) => adapter.close(silent),
    // Transitional escape hatch for tests and migration tooling; components must use the domain APIs below.
    call,

    engineering: { get: (p) => call("engineering.get", p), put: (p) => call("engineering.put", p) },
    sandbox: { create: (p = {}) => call("sandbox.create", p), inspect: (p) => call("sandbox.inspect", p), apply: (p) => call("sandbox.apply", p) },
    feedback: { emit: (p) => call("feedback.emit", p) },

    workspace: {
      open: (p) => call("workspace.open", p),
      close: () => call("workspace.close", empty()),
      browse: (p) => call("workspace.browse", p),
      removeRecent: (p) => call("workspace.remove_recent", p),
    },
    files: {
      read: (p) => call("fs.read", p), tree: (p) => call("fs.tree", p), search: (p) => call("fs.search", p),
      hash: (p) => call("fs.hash", p), write: (p) => call("fs.write", p), patch: (p) => call("fs.patch", p),
      create: (p) => call("fs.create", p), delete: (p) => call("fs.delete", p), rename: (p) => call("fs.rename", p),
      copy: (p) => call("fs.copy", p), beginWrite: (p) => call("fs.begin_write", p), writeChunk: (p) => call("fs.write_chunk", p),
      commitWrite: (p) => call("fs.commit_write", p), abortWrite: (p) => call("fs.abort_write", p), export: (p) => call("fs.export", p),
    },
    trash: {
      list: () => call("trash.list", empty()), restore: (p) => call("trash.restore", p), delete: (p) => call("trash.delete", p), empty: () => call("trash.empty", empty()),
    },
    checkpoint: {
      tasks: () => call("checkpoint.tasks", empty()), task: (p) => call("checkpoint.task", p), diff: (p) => call("checkpoint.diff", p),
      revertEvent: (p) => call("checkpoint.revert_event", p), revertFile: (p) => call("checkpoint.revert_file", p), revertTask: (p) => call("checkpoint.revert_task", p),
    },
    profiles: {
      list: () => call("profiles.list", empty()), save: (p) => call("profiles.save", p), delete: (p) => call("profiles.delete", p),
      test: (p) => call("profiles.test", p), models: (p) => call("profiles.models", p),
    },
    permissions: { set: (p) => call("permissions.set", p) },
    approval: { respond: (p) => call("approval.respond", p) },
    agent: {
      start: (p) => call("agent.start", p), stop: () => call("agent.stop", empty()), answer: (p) => call("agent.answer", p),
    },
    instructions: {
      constitution: () => call("instructions.constitution", empty()), get: () => call("instructions.get", empty()), set: (p) => call("instructions.set", p),
    },
    git: {
      status: () => call("git.status", empty()), diff: (p) => call("git.diff", p), stage: (p) => call("git.stage", p),
      unstage: (p) => call("git.unstage", p), discard: (p) => call("git.discard", p), reset: (p) => call("git.reset", p),
      commit: (p) => call("git.commit", p), branches: () => call("git.branches", empty()), checkout: (p) => call("git.checkout", p),
      log: (p = {}) => call("git.log", p), blame: (p) => call("git.blame", p), pull: () => call("git.pull", empty()),
      push: () => call("git.push", empty()), init: () => call("git.init", empty()),
    },
    terminal: {
      run: (p) => call("terminal.run", p), kill: (p) => call("terminal.kill", p), open: (p) => call("terminal.open", p),
      input: (p) => call("terminal.input", p), resize: (p) => call("terminal.resize", p), close: (p) => call("terminal.close", p),
      list: () => call("terminal.list", empty()), history: (p) => call("terminal.history", p),
    },
    ports: { list: () => call("ports.list", empty()) },
    conversations: {
      list: () => call("conv.list", empty()), get: (p) => call("conv.get", p), delete: (p) => call("conv.delete", p), compact: (p) => call("conversation.compact", p),
    },
    devices: {
      pairCode: () => call("devices.pair_code", empty()), list: () => call("devices.list", empty()), revoke: (p) => call("devices.revoke", p),
    },
    remote: { pair: (target, code, name) => adapter.pair(target, code, name) },
  };
  return api;
}

export const runtime = createRuntime();
