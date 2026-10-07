import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";

const fake = installFakeDom({ width: 1440, height: 900 });
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe(element) { this.element = element; }
  disconnect() { this.disconnected = true; }
};
const { runtime } = await import("../../apps/web/src/services/app.js");
const { createTerminalDock } = await import("../../apps/web/src/components/terminal.js");
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

test("终端按容器尺寸调整 PTY，合并重复通知，隐藏不伪造尺寸，销毁后停止观察", async () => {
  const resized = [], closed = [];
  runtime.terminal.list = async () => ({ sessions: [] });
  runtime.terminal.open = async () => ({ id: "临时终端" });
  runtime.terminal.resize = async (params) => { resized.push(params); };
  runtime.terminal.close = async (params) => { closed.push(params); };
  const dock = createTerminalDock(); fake.doc.body.append(dock.el); dock.show();
  const out = dock.el.querySelector(".term-out"), observer = observers.at(-1);
  out.clientWidth = 660; out.clientHeight = 180;
  await flush();
  assert.deepEqual(resized, [{ id: "临时终端", cols: 80, rows: 10 }]);
  observer.callback(); observer.callback(); fake.fireWindow("resize"); await flush();
  assert.equal(resized.length, 1);
  out.clientWidth = 820; out.clientHeight = 360; observer.callback(); await flush();
  assert.deepEqual(resized.at(-1), { id: "临时终端", cols: 100, rows: 20 });
  dock.hide(); out.clientWidth = 0; out.clientHeight = 0; observer.callback(); await flush();
  assert.equal(resized.length, 2); assert.deepEqual(closed, []);
  dock.destroy(); assert.equal(observer.disconnected, true);
  out.clientWidth = 1000; observer.callback(); fake.fireWindow("resize"); await flush();
  assert.equal(resized.length, 2); assert.deepEqual(closed, []);
});

test("终端列表尚在读取时销毁界面，异步返回不创建新进程", async () => {
  let resolveList, opened = 0;
  runtime.terminal.list = () => new Promise((resolve) => { resolveList = resolve; });
  runtime.terminal.open = async () => { opened++; return { id: "不应创建" }; };
  const dock = createTerminalDock(); fake.doc.body.append(dock.el); dock.show(); dock.destroy();
  resolveList({ sessions: [] }); await flush();
  assert.equal(opened, 0); assert.equal(observers.at(-1).disconnected, true);
});
