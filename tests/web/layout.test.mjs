import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";

const dom = installFakeDom({ width: 1440, height: 950 });
const { setupLayout } = await import("../../apps/web/src/components/layout.js");
const { hasLayers } = await import("../../apps/web/src/components/overlays.js");
const { viewportMode } = await import("../../apps/web/src/services/viewport.js");
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function viewport(width, height = 950, coarse = false, shortSide = Math.min(width, height)) {
  window.innerWidth = globalThis.innerWidth = width; window.innerHeight = globalThis.innerHeight = height;
  globalThis.matchMedia = (query) => ({ matches: query === "(pointer: coarse)" && coarse, media: query });
  globalThis.screen = { width: shortSide, height: Math.max(width, height) };
}
function fixture({ width = 1440, height = 950, coarse = false, shortSide, stored = {} } = {}) {
  viewport(width, height, coarse, shortSide);
  for (const key of ["dfx.filesW", "dfx.aiW", "dfx.terminalH"]) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
  document.body.textContent = "";
  const el = (tag, cls) => { const node = document.createElement(tag); node.className = cls; node.focus = () => { document.activeElement = node; }; return node; };
  const app = el("div", ""), bar = el("header", "appbar"), files = el("aside", "files"), ai = el("section", "ai"), grip = el("div", "grip"), scrim = el("div", "drawer-scrim");
  app.setAttribute("id", "app"); bar.offsetHeight = 56;
  const center = el("div", "center-stack"), work = el("div", "work"), terminal = el("section", "terminal-dock");
  let centerHeight = height - 56;
  center.getBoundingClientRect = () => ({ left: 0, top: 56, width: window.innerWidth, height: centerHeight });
  const r1 = el("div", "resizer r1"), r2 = el("div", "resizer r2"), r3 = el("div", "resizer r3");
  const firstFile = el("button", "first-file"), lastFile = el("button", "last-file"), firstAI = el("button", "first-ai"), lastAI = el("button", "last-ai");
  files.append(firstFile, lastFile); ai.append(grip, firstAI, lastAI); center.append(r3, terminal); work.append(files, r1, center, r2, ai); app.append(bar, work, scrim); document.body.append(app);
  let closedAI = 0;
  const layout = setupLayout({ app, files, ai, grip, scrim, terminal, resizers: { r1, r2, r3 }, onCloseAI: () => { closedAI++; } });
  const resize = (width, height = window.innerHeight, coarse = false, shortSide) => { viewport(width, height, coarse, shortSide); dom.fireWindow("resize"); };
  const css = (key) => parseFloat(app.style.getPropertyValue(key));
  return { app, files, ai, grip, scrim, center, r1, r2, r3, firstFile, lastFile, firstAI, lastAI, layout, resize, css, get closedAI() { return closedAI; }, setCenterHeight(value) { centerHeight = value; } };
}
function fire(node, type, props = {}) { node.dispatchEvent({ type, pointerId: 7, button: 0, preventDefault() { this.prevented = true; }, ...props }); }
function key(node, value, props = {}) { let prevented = false; node.dispatchEvent({ type: "keydown", key: value, preventDefault() { prevented = true; }, ...props }); return prevented; }

test("设备断点区分平板和横屏手机，软键盘不改变物理设备类别", () => {
  assert.equal(viewportMode({ width: 900, height: 700, coarse: false }), "desktop");
  assert.equal(viewportMode({ width: 899, height: 700, coarse: false }), "tablet");
  assert.equal(viewportMode({ width: 599, height: 1000, coarse: false }), "phone");
  assert.equal(viewportMode({ width: 1024, height: 350, coarse: true, shortSide: 768 }), "tablet");
  assert.equal(viewportMode({ width: 844, height: 390, coarse: true, shortSide: 390 }), "phone");
});

test("900px桌面恢复最大面板后仍保留360px编辑器，放大恢复首选尺寸", () => {
  const f = fixture({ width: 900, stored: { "dfx.filesW": 460, "dfx.aiW": 640 } });
  try {
    f.layout.syncPanels({ filesVisible: true, aiVisible: true });
    assert.equal(f.layout.device, "desktop"); assert.equal(f.layout.mode, "wide");
    assert.ok(f.css("--files-w") + f.css("--ai-w") + 2 + 360 <= 900);
    assert.equal(f.r1.getAttribute("aria-valuemin"), "180"); assert.equal(f.r2.getAttribute("aria-orientation"), "vertical");
    f.resize(1600); assert.equal(f.css("--files-w"), 460); assert.equal(f.css("--ai-w"), 640);
    assert.equal(localStorage.getItem("dfx.filesW"), "460"); assert.equal(localStorage.getItem("dfx.aiW"), "640");
    f.layout.syncPanels({ filesVisible: false }); assert.equal(f.files.inert, true); assert.equal(f.r1.getAttribute("tabindex"), "-1"); assert.equal(f.ai.inert, false);
  } finally { f.layout.destroy(); }
});

test("损坏的面板尺寸不会进入布局，键盘尺寸受动态边界约束并保存", () => {
  const f = fixture({ width: 900, stored: { "dfx.filesW": "Infinity", "dfx.aiW": "-800", "dfx.terminalH": "NaN" } });
  try {
    f.layout.syncPanels({ aiVisible: true, terminalVisible: true });
    assert.ok(Number.isFinite(f.css("--files-w"))); assert.equal(f.css("--ai-w"), 280);
    assert.equal(key(f.r1, "End"), true);
    assert.ok(f.css("--files-w") + f.css("--ai-w") + 362 <= 900);
    assert.equal(key(f.r2, "Home"), true); assert.equal(f.css("--ai-w"), 280);
    assert.equal(localStorage.getItem("dfx.aiW"), "280");
    assert.equal(Number(f.r1.getAttribute("aria-valuenow")), f.css("--files-w"));
  } finally { f.layout.destroy(); }
});

test("取消拖动与失去指针捕获恢复原尺寸，模式切换清理进行中的拖动", () => {
  const f = fixture();
  try {
    f.layout.syncPanels({ aiVisible: true });
    fire(f.r1, "pointerdown", { clientX: 264 }); fire(f.r1, "pointermove", { clientX: 390 });
    assert.equal(f.css("--files-w"), 390); fire(f.r1, "pointercancel"); assert.equal(f.css("--files-w"), 264); assert.equal(f.r1.classList.contains("dragging"), false);
    fire(f.r2, "pointerdown", { clientX: 1060 }); fire(f.r2, "pointermove", { clientX: 900 }); fire(f.r2, "lostpointercapture"); assert.equal(f.css("--ai-w"), 380);
    fire(f.r1, "pointerdown", { clientX: 264 }); fire(f.r1, "pointermove", { clientX: 350 }); f.resize(768, 1024, true, 768);
    assert.equal(f.r1.classList.contains("dragging"), false); f.resize(1440); assert.equal(f.css("--files-w"), 264);
    assert.equal(localStorage.getItem("dfx.filesW"), null);
  } finally { f.layout.destroy(); }
});

test("平板文件初始关闭，左侧与右侧在空间充足时推开内容，窄屏改为覆盖", async () => {
  const f = fixture({ width: 1024, height: 768, coarse: true, shortSide: 768 });
  try {
    f.layout.syncPanels({ filesVisible: true, aiVisible: false }); assert.equal(f.files.inert, true);
    f.layout.openDrawer(); assert.equal(f.app.classList.contains("files-open"), true); assert.equal(f.css("--layout-left"), 320); assert.equal(f.center.inert, false);
    f.layout.syncPanels({ aiVisible: true }); assert.equal(f.app.classList.contains("files-open"), false); assert.equal(f.css("--layout-right"), 420); assert.equal(f.closedAI, 0);
    f.resize(768, 1024, true, 768); assert.equal(f.css("--layout-right"), 0); assert.equal(f.center.inert, true); assert.equal(f.ai.getAttribute("aria-modal"), "true");
    await tick(); f.scrim.click(); assert.equal(f.closedAI, 1); assert.equal(f.ai.inert, true); assert.equal(f.center.inert, false);
    f.layout.openDrawer(); assert.equal(f.files.getAttribute("aria-modal"), "true"); assert.equal(f.css("--layout-left"), 0);
  } finally { f.layout.destroy(); }
  assert.equal(hasLayers(), false);
});

test("大平板左右面板可同时常驻，其他功能侧栏占位会重新保护中心空间", () => {
  const f = fixture({ width: 1366, height: 1024, coarse: true, shortSide: 1024 });
  try {
    f.layout.openDrawer(); f.layout.syncPanels({ aiVisible: true });
    assert.equal(f.css("--layout-left"), 320); assert.equal(f.css("--layout-right"), 420); assert.equal(f.center.inert, false);
    f.app.style.setProperty("--surface-left", "500px"); dom.fireWindow("koide:surface-layout");
    assert.equal(f.app.classList.contains("files-open"), false); assert.equal(f.css("--layout-left"), 0); assert.equal(f.css("--layout-right"), 0); assert.equal(f.center.inert, true);
    f.app.style.removeProperty("--surface-left"); dom.fireWindow("koide:surface-layout"); assert.equal(f.css("--layout-right"), 420); assert.equal(f.center.inert, false);
  } finally { f.layout.destroy(); }
});

test("覆盖侧栏圈定键盘焦点，关闭文件面板返回触发按钮", async () => {
  const f = fixture({ width: 768, height: 1024, coarse: true, shortSide: 768 });
  try {
    const trigger = document.createElement("button"); trigger.focus = () => { document.activeElement = trigger; }; document.body.append(trigger); trigger.focus();
    f.layout.openDrawer(trigger); await tick(); assert.equal(document.activeElement, f.firstFile);
    f.lastFile.focus(); let prevented = false; dom.fireDoc("keydown", { key: "Tab", preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(document.activeElement, f.firstFile);
    dom.fireDoc("keydown", { key: "Tab", shiftKey: true, preventDefault() {} }); assert.equal(document.activeElement, f.lastFile);
    f.layout.closeDrawer(); assert.equal(document.activeElement, trigger); assert.equal(hasLayers(), false);
  } finally { f.layout.destroy(); }
});

test("手机全屏切到桌面立即释放历史层，再回手机不会留下全屏或遮罩", () => {
  const f = fixture({ width: 390, height: 844 });
  try {
    f.layout.syncPanels({ aiVisible: true }); f.layout.openSheetHalf(); assert.equal(f.css("--sheet-h"), 422);
    assert.equal(key(f.grip, "End"), true); assert.equal(f.ai.classList.contains("full"), true); assert.equal(hasLayers(), true);
    f.resize(1440, 950); assert.equal(f.ai.classList.contains("full"), false); assert.equal(hasLayers(), false); assert.equal(f.ai.inert, false); assert.equal(f.closedAI, 0);
    f.resize(390, 844); f.layout.openSheetHalf(); assert.equal(f.css("--sheet-h"), 422); assert.equal(f.ai.classList.contains("full"), false);
    f.layout.openDrawer(); assert.equal(hasLayers(), true); f.resize(1440); assert.equal(hasLayers(), false); assert.equal(f.app.classList.contains("files-open"), false);
  } finally { f.layout.destroy(); }
});

test("用户关闭面板回退一次历史，布局自动互斥或模式清理静默移除", async () => {
  await tick();
  const f = fixture({ width: 768, height: 1024, coarse: true, shortSide: 768 });
  const original = history.back; let backs = 0;
  history.back = () => { backs++; original(); };
  try {
    f.layout.openDrawer(); f.layout.closeDrawer(); assert.equal(backs, 1); await tick();
    f.layout.openDrawer(); f.layout.syncPanels({ aiVisible: true }); assert.equal(backs, 1, "自动关闭另一侧面板不回退当前用户的历史");
    f.layout.syncPanels({ aiVisible: false }); assert.equal(backs, 2); await tick();
    f.layout.openDrawer(); f.resize(1440); assert.equal(backs, 2, "跨设备模式清理不会返回上一页");
  } finally { history.back = original; f.layout.destroy(); }
});

test("终端高度支持键盘和持久化，缩小中心暂时压缩而不覆盖首选值", () => {
  const f = fixture();
  try {
    f.setCenterHeight(800); f.layout.syncPanels({ terminalVisible: true });
    assert.equal(key(f.r3, "End"), true); assert.equal(f.css("--terminal-h"), 580); assert.equal(localStorage.getItem("dfx.terminalH"), "580");
    f.setCenterHeight(500); f.resize(1440); assert.equal(f.css("--terminal-h"), 280);
    f.setCenterHeight(800); f.resize(1440); assert.equal(f.css("--terminal-h"), 580);
    assert.equal(key(f.r3, "Home"), true); assert.equal(f.css("--terminal-h"), 140); assert.equal(f.r3.getAttribute("aria-orientation"), "horizontal");
    f.layout.syncPanels({ terminalVisible: false }); assert.equal(f.r3.getAttribute("tabindex"), "-1"); assert.equal(key(f.r3, "End"), false);
  } finally { f.layout.destroy(); }
});
