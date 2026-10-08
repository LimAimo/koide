import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";

const fake = installFakeDom({ width: 1440, height: 900 });
const { doc, win, fireDoc, fireWindow } = fake;
let coarse = false, available = 1200, backCalls = 0, lateTraversal = false;
globalThis.screen = { width: 1440, height: 900 };
globalThis.matchMedia = (query) => ({ matches: query.includes("pointer: coarse") && coarse, media: query });
win.dispatchEvent = (event) => fireWindow(event.type, event);
const originalCreate = doc.createElement;
const matches = (node, selector) => selector.split(",").some((item) => {
  item = item.trim();
  if (item.startsWith(".")) return node.classList.contains(item.slice(1));
  if (item === "[hidden]") return node.hidden;
  if (item === "[inert]") return node.inert;
  if (item === "[data-surface-side]") return !!node.dataset.surfaceSide;
  if (item === "[role='button']") return node.getAttribute("role") === "button";
  return node.tagName.toLowerCase() === item;
});
doc.createElement = (tag) => {
  const node = originalCreate(tag);
  node.focus = () => { doc.activeElement = node; };
  node.closest = (selector) => { for (let current = node; current?.nodeType === 1; current = current.parentNode) if (matches(current, selector)) return current; return null; };
  Object.defineProperty(node, "isConnected", { get: () => doc.body.contains(node) });
  return node;
};
const entries = [{ state: null }];
globalThis.history = {
  get state() { return entries.at(-1).state; },
  pushState(state) { entries.push({ state }); },
  back() {
    backCalls++;
    if (lateTraversal) setTimeout(() => { if (entries.length > 1) entries.pop(); fireWindow("popstate", { state: entries.at(-1).state }); }, 0);
    else { if (entries.length > 1) entries.pop(); const state = entries.at(-1).state; setTimeout(() => fireWindow("popstate", { state }), 0); }
  },
};
const { h } = await import("../../apps/web/src/components/dom.js");
const { configureSurfaces, dismissPageSurfaces, openSheet, openDialog, openMenu, pushLayer, hasLayers } = await import("../../apps/web/src/components/overlays.js");
const app = h("div", { id: "app" });
const center = h("div", { class: "center-stack" });
const pageHost = h("div", { class: "workspace-pages", hidden: true });
center.getBoundingClientRect = () => ({ left: 0, top: 56, width: available, height: 844 });
app.append(center, pageHost); doc.body.append(app);
configureSurfaces({ app, pageHost });
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const resize = (width, height = 900, isCoarse = false) => {
  coarse = isCoarse; globalThis.innerWidth = win.innerWidth = width; globalThis.innerHeight = win.innerHeight = height;
  globalThis.screen.width = width; globalThis.screen.height = height; fireWindow("resize");
};
const trigger = (side) => {
  const node = h("button", { dataset: { surfaceSide: side } }, side);
  app.append(node); node.focus(); return node;
};
const key = (value, extra = {}) => {
  const event = { key: value, prevented: false, preventDefault() { event.prevented = true; }, stopPropagation() {}, ...extra };
  fireDoc("keydown", event); return event;
};

test("桌面设置式页面进入主区域，普通面板居中，不限制外围分栏", async () => {
  resize(1440); available = 1100;
  const button = trigger("right"), content = h("input", { value: "保留草稿" });
  const page = openSheet({ title: "设置", presentation: "page", body: content, anchor: button });
  assert.equal(page.el.dataset.placement, "page"); assert.equal(page.el.parentNode, pageHost);
  assert.equal(page.el.getAttribute("role"), "region"); assert.equal(app.inert, undefined);
  assert.equal(pageHost.hidden, false); page.close.dismiss(); assert.equal(pageHost.hidden, true);
  const panel = openSheet({ title: "历史", body: h("p", null, "记录"), anchor: button });
  assert.equal(panel.el.dataset.placement, "panel"); assert.equal(app.inert, true);
  panel.close.dismiss(); assert.equal(app.inert, false); await flush();
});

test("平板768、1024、1440侧栏均覆盖，方向由左右按钮决定", async () => {
  for (const width of [768, 1024, 1440]) {
    resize(width, 1024, true); available = width;
    for (const side of ["left", "right"]) {
      const button = trigger(side), before = center.getBoundingClientRect();
      const panel = openSheet({ title: "侧栏工具", body: "内容", anchor: button });
      assert.equal(panel.el.dataset.placement, "sidepane"); assert.equal(panel.el.dataset.side, side); assert.equal(panel.el.dataset.push, "false");
      assert.equal(panel.el.getAttribute("role"), "dialog"); assert.equal(panel.el.getAttribute("aria-modal"), "true"); assert.equal(app.inert, true);
      assert.equal(app.style.getPropertyValue("--surface-left"), ""); assert.equal(app.style.getPropertyValue("--surface-right"), ""); assert.equal(app.dataset.surfacePush, undefined);
      assert.deepEqual(center.getBoundingClientRect(), before);
      panel.close.dismiss(); assert.equal(app.inert, false); await flush();
    }
  }
});

test("平板已有侧栏时新面板仍使用遮罩并保持嵌套隔离", async () => {
  resize(1024, 900, true); available = 704;
  const first = openSheet({ title: "文件工具", body: "内容", anchor: trigger("left") });
  const panel = openSheet({ title: "设置", body: "内容", side: "right" });
  assert.equal(panel.el.dataset.push, "false"); assert.equal(app.style.getPropertyValue("--surface-right"), ""); assert.equal(app.inert, true);
  panel.close.dismiss(); assert.equal(app.inert, true); first.close.dismiss(); assert.equal(app.inert, false); await flush();
});

test("平板横竖屏变化保留输入焦点、选区和模态键盘循环", async () => {
  resize(768, 1024, true); available = 768;
  const button = trigger("right"), input = h("input", { type: "text", value: "未提交草稿" });
  const panel = openSheet({ title: "设置", body: input, anchor: button });
  await flush(); input.focus(); input.setSelectionRange(1, 3);
  resize(1440, 1024, true); available = 1440; fireWindow("resize");
  assert.equal(panel.el.dataset.push, "false"); assert.equal(panel.content.firstChild, input); assert.equal(input.value, "未提交草稿"); assert.equal(doc.activeElement, input);
  assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 3); assert.equal(app.inert, true);
  assert.equal(key("Tab").prevented, true); assert.equal(doc.activeElement, panel.el.querySelector(".sheet-close"));
  assert.equal(key("Tab", { shiftKey: true }).prevented, true); assert.equal(doc.activeElement, input);
  key("Escape"); assert.equal(doc.activeElement, button); assert.equal(app.inert, false); await flush();
});

test("工作台CSS隐藏的外层关闭按钮不抢首次焦点或Tab循环", async () => {
  resize(1024, 900, true);
  const origin = trigger("right"), first = h("button", { type: "button" }, "返回代码"), last = h("button", { type: "button" }, "工作台末尾操作");
  const body = h("section", { class: "studio-workbench" }, first, last);
  const panel = openSheet({ title: "创作工作台", presentation: "page", body, anchor: origin });
  const heading = panel.el.querySelector(".sheet-heading"), outerClose = panel.el.querySelector(".sheet-close");
  heading.style.display = "none";
  // 模拟真实浏览器中 desktop.css 隐藏工作台外层标题后的布局矩形，保留DOM节点。
  outerClose.getClientRects = () => heading.style.display === "none" ? [] : [{}];
  await flush(); assert.equal(doc.activeElement, first); assert.equal(app.inert, true);
  last.focus(); assert.equal(key("Tab").prevented, true); assert.equal(doc.activeElement, first);
  assert.equal(key("Tab", { shiftKey: true }).prevented, true); assert.equal(doc.activeElement, last);
  key("Escape"); assert.equal(doc.activeElement, origin); assert.equal(app.inert, false); await flush();
});

test("模式切换移动原有输入节点并清理手机拖动状态", async () => {
  resize(390, 844); available = 390;
  const input = h("input", { value: "原始草稿" }), panel = openSheet({ title: "草稿", body: input, presentation: "page" });
  assert.equal(panel.el.dataset.placement, "bottomsheet"); input.value = "尚未提交的输入";
  input.focus(); input.setSelectionRange(1, 3);
  const grip = panel.el.querySelector(".sheet-handle");
  grip.dispatchEvent({ type: "pointerdown", pointerId: 1, clientY: 20 }); grip.dispatchEvent({ type: "pointermove", pointerId: 1, clientY: 80 });
  assert.match(panel.el.style.transform, /translateY/);
  resize(1440); available = 1100; fireWindow("resize");
  assert.equal(panel.el.dataset.placement, "page"); assert.equal(panel.content.firstChild, input); assert.equal(input.value, "尚未提交的输入");
  assert.equal(doc.activeElement, input); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 3);
  assert.equal(panel.el.style.transform, ""); assert.equal(panel.el.classList.contains("dragging"), false);
  panel.close.dismiss(); await flush();
});

test("手机设置保持完整页面，普通功能保留底部面板", async () => {
  resize(390, 844); available = 390;
  const page = openSheet({ title: "设置", body: "内容", presentation: "page", mobileFullscreen: true });
  assert.equal(page.el.dataset.placement, "fullscreen"); assert.equal(app.inert, true);
  page.close.dismiss(); await flush();
});

test("居中确认框限制Tab循环，Esc关闭并恢复按钮焦点", async () => {
  resize(1440); const button = trigger("right");
  const dialog = openDialog({ title: "确定操作", body: "说明", anchor: button, actions: [{ label: "取消" }, { label: "确定" }] });
  await flush(); const buttons = dialog.el.querySelectorAll("button");
  assert.equal(doc.activeElement, buttons[0]); buttons.at(-1).focus(); assert.equal(key("Tab").prevented, true); assert.equal(doc.activeElement, buttons[0]);
  assert.equal(key("Tab", { shiftKey: true }).prevented, true); assert.equal(doc.activeElement, buttons.at(-1));
  key("Escape"); assert.equal(doc.activeElement, button); assert.equal(app.inert, false); await flush();
});

test("嵌套对话框关闭后仍保持下层面板背景隔离", async () => {
  resize(1440); const panel = openSheet({ title: "编辑", body: h("input", { value: "草稿" }) });
  const dialog = openDialog({ title: "确认", body: "说明", actions: [{ label: "确定" }] });
  assert.equal(app.inert, true); dialog.close.dismiss(); assert.equal(app.inert, true);
  panel.close.dismiss(); assert.equal(app.inert, false); await flush();
});

test("桌面菜单锚定在触发按钮附近并支持完整键盘导航", async () => {
  resize(1440); const button = trigger("right"); button.getBoundingClientRect = () => ({ left: 1260, top: 40, width: 40, height: 40, right: 1300, bottom: 80 });
  const menu = openMenu("操作", [{ label: "一" }, { label: "二" }, { label: "三" }], { anchor: button });
  assert.equal(menu.el.classList.contains("surface-popover"), true); assert.equal(menu.el.style.left, "1000px"); assert.equal(menu.el.style.top, "86px");
  await flush(); const items = menu.content.querySelectorAll("button"); assert.equal(doc.activeElement, items[0]);
  key("ArrowDown"); assert.equal(doc.activeElement, items[1]); key("End"); assert.equal(doc.activeElement, items[2]); key("Home"); assert.equal(doc.activeElement, items[0]); key("ArrowUp"); assert.equal(doc.activeElement, items[2]);
  key("Escape"); assert.equal(doc.activeElement, button); await flush();
});

test("关闭请求幂等，异步历史返回不会关闭随后打开的弹层", async () => {
  resize(1440); const before = backCalls; let firstClosed = 0, secondClosed = 0;
  const first = openSheet({ title: "先前面板", body: "内容", onClose: () => firstClosed++ });
  first.close(); first.close(); assert.equal(firstClosed, 1); assert.equal(backCalls, before + 1);
  const second = openDialog({ title: "新的确认", body: "内容", onClose: () => secondClosed++ });
  await flush(); assert.equal(secondClosed, 0); assert.equal(hasLayers(), true);
  second.close.dismiss(); assert.equal(secondClosed, 1); await flush();
});

test("布局静默移除不会触发history.back或关闭新的顶层", async () => {
  const before = backCalls; let calls = 0;
  const old = pushLayer(() => calls++); const next = pushLayer(() => calls++);
  old.dismiss(); old.dismiss(); assert.equal(calls, 1); assert.equal(backCalls, before); assert.equal(next.isTop(), true);
  next.dismiss(); assert.equal(calls, 2); assert.equal(hasLayers(), false); await flush();
});

test("明确打开文件仅退出完整功能页，普通面板和确认框保持原样", async () => {
  resize(1440); available = 1100;
  let pageClosed = 0, panelClosed = 0, dialogClosed = 0;
  const page = openSheet({ title: "设置", presentation: "page", body: "内容", onClose: () => pageClosed++ });
  const panel = openSheet({ title: "工具", body: "内容", onClose: () => panelClosed++ });
  const dialog = openDialog({ title: "确认", body: "内容", onClose: () => dialogClosed++ });
  const calls = backCalls; dismissPageSurfaces();
  assert.equal(pageClosed, 1); assert.equal(panelClosed, 0); assert.equal(dialogClosed, 0); assert.equal(backCalls, calls); assert.equal(dialog.close.isTop(), true);
  assert.equal(pageHost.hidden, true); assert.equal(app.inert, true);
  panel.close.dismiss(); dialog.close.dismiss(); await flush();
  resize(768, 1024, true); available = 768;
  const tablet = openSheet({ title: "设置", presentation: "page", body: "内容", onClose: () => pageClosed++ });
  assert.equal(tablet.el.dataset.placement, "sidepane"); dismissPageSurfaces(); assert.equal(pageClosed, 2);
  resize(390, 844);
  const phone = openSheet({ title: "设置", presentation: "page", mobileFullscreen: true, body: "内容", onClose: () => pageClosed++ });
  assert.equal(phone.el.dataset.placement, "fullscreen"); dismissPageSurfaces(); assert.equal(pageClosed, 3);
  assert.equal(hasLayers(), false); await flush();
  resize(1440); available = 1100;
  const origin = trigger("right"), other = trigger("left");
  const navigationPage = openSheet({ title: "设置", presentation: "page", body: h("input", { value: "偏好" }), anchor: origin });
  await flush(); other.focus(); dismissPageSurfaces(); assert.equal(doc.activeElement, other, "明确导航保留用户新选中的文件 / 控件焦点");
  assert.equal(navigationPage.close.isTop(), false); await flush();
});

test("浏览器延迟执行history导航时，新对话框仍拥有自己的返回状态并继承菜单来源焦点", async () => {
  resize(1440); lateTraversal = true;
  const origin = trigger("left"); let dialog;
  const menu = openMenu("文件", [{ label: "重命名", onClick: () => { dialog = openDialog({ title: "重命名", body: h("input", { value: "草稿" }), actions: [{ label: "取消" }] }); } }], { anchor: origin });
  const item = menu.content.querySelector("button");
  fireDoc("click", { target: item }); item.click();
  const pendingState = history.state.koideLayer;
  await flush();
  assert.notEqual(history.state.koideLayer, pendingState, "旧菜单的back落定后才写入新对话框状态");
  assert.equal(dialog.close.isTop(), true); key("Escape"); await flush();
  assert.equal(doc.activeElement, origin); assert.equal(hasLayers(), false); assert.equal(app.inert, false);
  lateTraversal = false;
});

test("设置分类、搜索与版本信息使用真实运行时且保留查询", async () => {
  resize(1440); available = 1100;
  const { state } = await import("../../apps/web/src/services/app.js");
  state.set({ hello: { version: "0.10.1", presets: {} }, profiles: [], workspace: null, conn: "off", permissions: null });
  const { openSettings } = await import("../../apps/web/src/components/settings.js");
  const settings = openSettings("advanced"), query = settings.el.querySelector("input[type='search']");
  assert.equal(settings.el.dataset.placement, "page"); assert.equal(settings.el.querySelectorAll(".settings-nav button").length, 11);
  assert.match(settings.el.textContent, /Koide 0\.10\.1 Web/);
  query.value = "字号"; query.dispatchEvent({ type: "input" });
  const sections = settings.el.querySelectorAll(".sec"); assert.equal(sections.find((node) => node.dataset.id === "editor").hidden, false); assert.equal(sections.find((node) => node.dataset.id === "providers").hidden, true);
  state.set({ conn: "online" }); assert.equal(query.value, "字号");
  query.value = "不存在的设置关键词"; query.dispatchEvent({ type: "input" }); assert.equal(settings.el.querySelector(".settings-empty").hidden, false);
  settings.close.dismiss(); await flush();
});

test("文件树鼠标长按不误开菜单，右键和键盘菜单保持来源焦点", async () => {
  resize(1440);
  const { state, runtime } = await import("../../apps/web/src/services/app.js");
  const { createFileTree } = await import("../../apps/web/src/components/file-tree.js");
  const originalTree = runtime.files.tree;
  runtime.files.tree = async () => [{ type: "file", name: "README.md", path: "README.md" }];
  state.set({ workspace: { name: "测试项目" }, editing: {}, active: null, git: null });
  let opens = 0; const previewModes = [];
  const tree = createFileTree({ onOpen: (_path, options) => { opens++; previewModes.push(options.preview); } }); app.append(tree.el); await tree.refresh();
  const row = tree.el.querySelector(".row");
  row.dispatchEvent({ type: "pointerdown", pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
  await new Promise((resolve) => setTimeout(resolve, 480)); assert.equal(hasLayers(), false);
  row.dispatchEvent({ type: "contextmenu", clientX: 100, clientY: 100, preventDefault() {} });
  assert.equal(hasLayers(), true); assert.equal(doc.body.querySelector(".surface-popover").style.top, "106px");
  key("Escape"); await flush(); assert.equal(doc.activeElement, row);
  row.dispatchEvent({ type: "keydown", key: "F10", shiftKey: true, preventDefault() {} }); assert.equal(hasLayers(), true);
  key("Escape"); await flush(); assert.equal(doc.activeElement, row);
  row.dispatchEvent({ type: "keydown", key: "ContextMenu", preventDefault() {} }); assert.equal(hasLayers(), true);
  key("Escape"); await flush();
  row.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} }); assert.equal(opens, 1);
  row.dispatchEvent({ type: "dblclick", preventDefault() {} }); assert.equal(opens, 2); assert.equal(previewModes.at(-1), false);
  tree.el.remove(); runtime.files.tree = originalTree; state.set({ workspace: null });
});

test("文件树取消触控指针不会遗留延迟菜单", async () => {
  resize(768, 1024, true); available = 768;
  const { state, runtime } = await import("../../apps/web/src/services/app.js");
  const { createFileTree } = await import("../../apps/web/src/components/file-tree.js");
  const originalTree = runtime.files.tree;
  runtime.files.tree = async () => [{ type: "file", name: "README.md", path: "README.md" }];
  state.set({ workspace: { name: "触控测试" }, editing: {}, active: null, git: null });
  const tree = createFileTree({ onOpen() {} }); app.append(tree.el); await tree.refresh();
  const row = tree.el.querySelector(".row");
  row.dispatchEvent({ type: "pointerdown", pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
  row.dispatchEvent({ type: "pointercancel" });
  await new Promise((resolve) => setTimeout(resolve, 480)); assert.equal(hasLayers(), false);
  tree.el.remove(); runtime.files.tree = originalTree; state.set({ workspace: null });
});

test("文件夹双击只展开一次，下一次单击能收起", async () => {
  resize(1440);
  const { state, runtime } = await import("../../apps/web/src/services/app.js");
  const { createFileTree } = await import("../../apps/web/src/components/file-tree.js");
  const originalTree = runtime.files.tree;
  runtime.files.tree = async ({ path }) => path === "." ? [{ type: "dir", name: "src", path: "src" }] : [];
  state.set({ workspace: { name: "文件夹测试" }, editing: {}, active: null, git: null });
  const tree = createFileTree({ onOpen() { assert.fail("目录操作不能打开文件"); } }); app.append(tree.el); await tree.refresh();
  const row = tree.el.querySelector(".row");
  row.dispatchEvent({ type: "click", detail: 1 }); row.dispatchEvent({ type: "click", detail: 2 }); row.dispatchEvent({ type: "dblclick", preventDefault() {} });
  await flush(); assert.equal(row.getAttribute("aria-expanded"), "true");
  row.dispatchEvent({ type: "click", detail: 1 }); await flush(); assert.equal(row.getAttribute("aria-expanded"), "false");
  tree.el.remove(); runtime.files.tree = originalTree; state.set({ workspace: null });
});
