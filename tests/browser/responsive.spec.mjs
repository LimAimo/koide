import { test, expect, bootWorkspace } from "./fixtures.mjs";

const app = (page) => page.locator("#app");
const surface = (page, title) => page.locator(`.adaptive-surface[aria-label="${title}"]`);
const geometry = (locator) => locator.evaluate((element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, display: getComputedStyle(element).display }; });
const mode = (testInfo) => testInfo.project.metadata.device;
const tabletSizes = [{ width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1440, height: 950 }];
const viewportKey = ({ width, height }) => `${width}x${height}`;
async function painted(page) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function collectClosedCenters(page, sizes = tabletSizes) {
  const original = page.viewportSize(), baselines = new Map();
  const originalMode = await app(page).getAttribute("data-layout");
  for (const size of sizes) {
    await page.setViewportSize(size);
    // 浏览器 resize 事件可能晚于两帧绘制；采样必须等真实布局模式切换完成。
    await expect(app(page)).toHaveAttribute("data-layout", "tablet"); await painted(page);
    baselines.set(viewportKey(size), await geometry(page.locator(".center-stack")));
  }
  await page.setViewportSize(original); await expect(app(page)).toHaveAttribute("data-layout", originalMode); await painted(page);
  return baselines;
}
async function assertCenterUnchanged(page, baselines) {
  const baseline = baselines.get(viewportKey(page.viewportSize()));
  expect(baseline, "当前视口应有关闭侧栏时的实测基准").toBeDefined();
  const center = await geometry(page.locator(".center-stack"));
  for (const key of ["x", "y", "width", "height"]) expect(Math.abs(center[key] - baseline[key]), `侧栏覆盖时编辑区 ${key} 应保持原值（${baseline[key]} → ${center[key]}）`).toBeLessThanOrEqual(1);
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
  const misses = await page.locator(".appbar button").evaluateAll((buttons) => buttons.filter((button) => {
    const r = button.getBoundingClientRect(); return r.width && r.height && (r.left < -1 || r.right > innerWidth + 1 || r.width < 40 || r.height < 40);
  }).map((button) => ({ label: button.getAttribute("aria-label"), rect: button.getBoundingClientRect().toJSON() })));
  expect(misses).toEqual([]);
}
async function toggleAI(page, visible) {
  const button = page.getByRole("button", { name: "显示或隐藏 AI 面板", exact: true });
  const hidden = (await app(page).getAttribute("class")).includes("ai-hidden");
  if (hidden === visible) await button.click();
  await expect(button).toHaveAttribute("aria-pressed", String(visible));
}
async function showFiles(page) {
  const mobile = page.locator(".appbar .menu-btn");
  if (await mobile.isVisible()) await mobile.click();
  else {
    const button = page.getByRole("button", { name: "显示或隐藏文件面板", exact: true });
    if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  }
  await expect(page.locator('.node[data-path="README.md"] > .row')).toBeVisible();
}
async function closeTop(page) { await page.keyboard.press("Escape"); await expect(page.locator(".adaptive-surface.in, .adaptive-dialog.in, .surface-popover")).toHaveCount(0); }
async function drag(page, locator, deltaX, deltaY = 0) {
  const r = await locator.boundingBox();
  expect(r).not.toBeNull();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  // 保持真实指针在窗口内；超出 CDP 视口会结束捕获，属于取消手势而不是极限拖动。
  const viewport = page.viewportSize();
  await page.mouse.move(Math.max(2, Math.min(viewport.width - 2, r.x + r.width / 2 + deltaX)), Math.max(2, Math.min(viewport.height - 2, r.y + r.height / 2 + deltaY)), { steps: 8 });
  await page.mouse.up();
}
async function assertDesktopColumns(page) {
  const files = await geometry(page.locator(".files")), center = await geometry(page.locator(".center-stack")), ai = await geometry(page.locator(".ai"));
  expect(files.width).toBeGreaterThanOrEqual(179);
  expect(ai.width).toBeGreaterThanOrEqual(279);
  expect(center.width).toBeGreaterThanOrEqual(359);
  expect(Math.abs(files.y - center.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(ai.y - center.y)).toBeLessThanOrEqual(1);
  expect(center.x).toBeGreaterThanOrEqual(files.right);
  expect(ai.x).toBeGreaterThanOrEqual(center.right);
  expect(Math.abs(ai.bottom - center.bottom)).toBeLessThanOrEqual(1);
  await expect(page.locator(".ai .grip")).toBeHidden();
  const modes = await page.locator(".ai-head .mode-slider button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect(), clip = button.closest(".seg-wrap").getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { label: button.textContent, width: rect.width, height: rect.height, withinClip: rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1, reachable: button === hit || button.contains(hit) };
  }));
  expect(modes.map((button) => button.label)).toEqual(["聊天", "只读", "编辑", "智能体"]);
  expect(modes.filter((button) => !button.withinClip || !button.reachable)).toEqual([]);
  await noOverflow(page);
}
async function assertSide(page, title, side, baselines) {
  const panel = surface(page, title), viewport = page.viewportSize();
  await expect(panel).toHaveClass(/\bin\b/);
  await expect(panel).toHaveAttribute("data-mode", "tablet");
  await expect(panel).toHaveAttribute("data-placement", "sidepane");
  await expect(panel).toHaveAttribute("data-side", side);
  await expect(panel).toHaveAttribute("data-push", "false");
  await expect(panel).toHaveAttribute("role", "dialog");
  await expect(panel).toHaveAttribute("aria-modal", "true");
  const r = await geometry(panel);
  expect(side === "left" ? Math.abs(r.x) : Math.abs(r.right - viewport.width)).toBeLessThanOrEqual(1);
  expect(r.height).toBeGreaterThan(viewport.height * 0.7);
  expect(await app(page).evaluate((element) => element.inert)).toBe(true);
  const scrim = page.locator(".surface-scrim.in").last();
  await expect(scrim).toBeVisible();
  expect(await scrim.evaluate((element) => element.hidden)).toBe(false);
  await assertCenterUnchanged(page, baselines);
  await noOverflow(page);
}
async function assertClean(page) {
  await expect(page.locator(".adaptive-surface, .adaptive-dialog, .surface-popover")).toHaveCount(0);
  expect(await app(page).evaluate((element) => element.inert)).toBe(false);
  expect(await app(page).evaluate((element) => [element.style.getPropertyValue("--surface-left"), element.style.getPropertyValue("--surface-right")])).toEqual(["", ""]);
}

test("真实编辑器布局、分栏极限与设备输入方式", async ({ page, services }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bootWorkspace(page, services);
  await expect(app(page)).toHaveAttribute("data-layout", mode(testInfo));
  await showFiles(page);
  await page.locator('.node[data-path="README.md"] > .row').click();
  await expect(page.locator(".cm-content").first()).toContainText("临时界面回归项目");

  if (mode(testInfo) === "desktop") {
    await showFiles(page); await toggleAI(page, true);
    await assertDesktopColumns(page);
    const r1 = page.getByRole("separator", { name: "调整文件面板宽度", exact: true });
    const r2 = page.getByRole("separator", { name: "调整 AI 面板宽度", exact: true });
    // 通过实际 pointer capture 走拖动流程；极限值必须给中央编辑器留出空间。
    await drag(page, r1, 1800); await assertDesktopColumns(page);
    await drag(page, r2, -1800); await assertDesktopColumns(page);
    await page.screenshot({ path: testInfo.outputPath("最大分栏.png"), fullPage: true });
    await drag(page, r1, -1800); await drag(page, r2, 1800); await assertDesktopColumns(page);
    const minFiles = await geometry(page.locator(".files")); expect(minFiles.width).toBeLessThanOrEqual(200);
    await r1.focus(); await expect(r1).toBeFocused(); await page.keyboard.press("ArrowRight");
    // 布局把高频调整合并到下一帧，等待实际绘制后的尺寸。
    await expect.poll(async () => (await geometry(page.locator(".files"))).width).toBeGreaterThan(minFiles.width);
    const saved = await geometry(page.locator(".files"));
    await page.reload(); await bootWorkspace(page, services); await toggleAI(page, true);
    expect(Math.abs((await geometry(page.locator(".files"))).width - saved.width)).toBeLessThanOrEqual(1);
    await page.locator('.node[data-path="README.md"] > .row').click();
    await expect(page.locator(".cm-content").first()).toContainText("临时界面回归项目");
    await assertDesktopColumns(page);
    await page.screenshot({ path: testInfo.outputPath("桌面常驻分栏.png"), fullPage: true });
    if (process.platform === "win32") {
      // Bridge 在 Windows 明确不提供交互式 PTY，不能用假会话制造成功状态。
      await page.getByRole("button", { name: "显示或隐藏终端", exact: true }).click();
      await expect(page.locator(".toast")).toContainText("不支持交互式终端");
      await expect(page.locator(".terminal-dock")).toBeHidden();
      await expect(page.getByRole("button", { name: "显示或隐藏终端", exact: true })).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByRole("separator", { name: "调整终端高度", exact: true })).toBeHidden();
    }
  } else if (mode(testInfo) === "tablet") {
    const baselines = await collectClosedCenters(page);
    await toggleAI(page, true);
    const ai = await geometry(page.locator(".ai")), viewport = page.viewportSize();
    expect(Math.abs(ai.right - viewport.width)).toBeLessThanOrEqual(1);
    expect(ai.height).toBeGreaterThan(viewport.height * 0.7);
    await expect(page.locator(".ai .grip")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("平板右侧AI.png"), fullPage: true });
    for (const size of tabletSizes) {
      await page.setViewportSize(size); await painted(page);
      await expect(app(page)).toHaveClass(/tablet-panel-overlay/);
      await expect(app(page)).not.toHaveClass(/files-open|tablet-files-push|tablet-ai-push/);
      await expect(page.locator(".ai")).toHaveAttribute("aria-modal", "true");
      expect(await page.locator(".center-stack").evaluate((element) => element.inert)).toBe(true);
      await assertCenterUnchanged(page, baselines);
      const scrim = page.locator(".drawer-scrim");
      expect(await scrim.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
      await showFiles(page);
      await expect(app(page)).toHaveClass(/files-open.*ai-hidden|ai-hidden.*files-open/);
      await expect(page.locator(".files")).toHaveAttribute("aria-modal", "true");
      expect(Math.abs((await geometry(page.locator(".files"))).x)).toBeLessThanOrEqual(1);
      await assertCenterUnchanged(page, baselines);
      await toggleAI(page, true);
      await expect(app(page)).not.toHaveClass(/files-open/);
      await expect(page.locator(".files")).toHaveAttribute("aria-hidden", "true");
      await assertCenterUnchanged(page, baselines);
    }
    await page.screenshot({ path: testInfo.outputPath("宽平板右侧AI覆盖.png"), fullPage: true });
    await expect(page.locator(".ai .mode-slider button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(app(page)).toHaveClass(/ai-hidden/);
    await expect(page.getByRole("button", { name: "显示或隐藏 AI 面板", exact: true })).toBeFocused();
    expect(await app(page).evaluate((element) => element.inert)).toBe(false);
    expect(await page.locator(".center-stack").evaluate((element) => element.inert)).toBe(false);
    await expect(app(page)).not.toHaveClass(/tablet-files-push|tablet-panel-overlay/);
    await showFiles(page);
    await page.screenshot({ path: testInfo.outputPath("宽平板左侧文件覆盖.png"), fullPage: true });
    await expect(page.locator(".files button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "显示或隐藏文件面板", exact: true })).toBeFocused();
    await assertCenterUnchanged(page, baselines);
    const code = page.locator(".cm-content").first();
    await code.click(); await expect(code).toBeFocused();
    // 真正的工作台通知入口自动展开 AI；不启动模型、不制造假的面板或焦点。
    await page.evaluate(async () => { const { events } = await import("/src/services/app.js"); events.emit("studio:show-chat"); });
    await expect(page.locator(".ai .mode-slider button").first()).toBeFocused();
    expect(await page.locator(".center-stack").evaluate((element) => element.inert)).toBe(true);
    await assertCenterUnchanged(page, baselines);
    await page.keyboard.press("Escape");
    await expect(app(page)).toHaveClass(/ai-hidden/);
    expect(await page.locator(".center-stack").evaluate((element) => element.inert)).toBe(false);
    await expect(code).toBeFocused();
    await noOverflow(page);
  } else {
    await toggleAI(page, true);
    const before = await geometry(page.locator(".ai")), viewport = page.viewportSize();
    expect(Math.abs(before.bottom - viewport.height)).toBeLessThanOrEqual(1);
    expect(before.height).toBeGreaterThan(viewport.height * 0.35);
    expect(before.height).toBeLessThan(viewport.height * 0.7);
    await expect(page.locator(".ai .grip")).toBeVisible();
    await drag(page, page.locator(".ai .grip"), 0, -120);
    expect((await geometry(page.locator(".ai"))).height).toBeGreaterThan(before.height + 50);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("手机可拖动AI.png"), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("完整设置页面保留输入，平板定向侧栏始终覆盖原编辑区", async ({ page, services }, testInfo) => {
  await bootWorkspace(page, services);
  await toggleAI(page, false);
  const baselines = mode(testInfo) === "tablet" ? await collectClosedCenters(page) : mode(testInfo) === "desktop" ? await collectClosedCenters(page, [tabletSizes[0]]) : new Map();
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await settings.click();
  const panel = surface(page, "设置"), search = panel.getByRole("searchbox", { name: "搜索设置", exact: true });
  await search.fill("权限");
  await expect(panel.locator('.sec[data-id="permissions"]')).toBeVisible();
  const permissionMode = panel.locator('.sec[data-id="permissions"] .srow.stack').first();
  const labelBox = await geometry(permissionMode.locator(".lbl")), controlBox = await geometry(permissionMode.locator(".ctl"));
  expect(labelBox.height).toBeLessThan(120);
  expect(controlBox.y - labelBox.bottom).toBeGreaterThanOrEqual(0);
  expect(controlBox.y - labelBox.bottom).toBeLessThan(32);
  await page.evaluate(() => { window.__RESPONSIVE_SEARCH__ = document.querySelector('.settings-surface input[type="search"]'); });

  if (mode(testInfo) === "desktop") {
    await expect(panel).toHaveAttribute("data-placement", "page");
    expect(await panel.evaluate((element) => !!element.closest(".workspace-pages"))).toBe(true);
    const p = await geometry(panel), center = await geometry(page.locator(".center-stack"));
    expect(Math.abs(p.x - center.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.width - center.width)).toBeLessThanOrEqual(1);
    expect(await app(page).evaluate((element) => element.inert)).toBe(false);
    await expect(panel.locator(".sheet-handle")).toBeHidden();
    await page.setViewportSize({ width: 768, height: 1024 });
    await assertSide(page, "设置", "right", baselines);
    await expect(search).toHaveValue("权限");
    await expect(search).toBeFocused();
    await page.setViewportSize(testInfo.project.use.viewport);
    await expect(panel).toHaveAttribute("data-placement", "page");
    await expect(search).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("桌面设置主页面.png"), fullPage: true });
  } else if (mode(testInfo) === "tablet") {
    await assertSide(page, "设置", "right", baselines);
    await page.screenshot({ path: testInfo.outputPath("平板设置初始.png"), fullPage: true });
    // 同一个输入节点在768/1024/1440保留文本与焦点；侧栏从不挤压编辑区。
    for (const size of tabletSizes) {
      await page.setViewportSize(size); await painted(page);
      await assertSide(page, "设置", "right", baselines);
      await expect(search).toHaveValue("权限"); await expect(search).toBeFocused();
    }
    await page.screenshot({ path: testInfo.outputPath("平板右侧覆盖.png"), fullPage: true });
  } else {
    await expect(panel).toHaveAttribute("data-placement", "fullscreen");
    expect(await app(page).evaluate((element) => element.inert)).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("手机设置.png"), fullPage: true });
  }
  expect(await search.evaluate((element) => element === window.__RESPONSIVE_SEARCH__)).toBe(true);
  await closeTop(page); await assertClean(page); await expect(settings).toBeFocused();

  // 位于左半边的实际工具栏按钮，方向与右侧设置按钮对应。
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const git = surface(page, "Git");
  await expect(git).toBeVisible();
  if (mode(testInfo) === "tablet") await assertSide(page, "Git", "left", baselines);
  if (mode(testInfo) === "phone") await expect(git).toHaveAttribute("data-placement", "bottomsheet");
  await page.screenshot({ path: testInfo.outputPath("左侧Git.png"), fullPage: true });
  await closeTop(page); await assertClean(page); await noOverflow(page);

  if (mode(testInfo) === "desktop") {
    await showFiles(page); await settings.click();
    await expect(surface(page, "设置")).toBeVisible();
    await page.locator('.node[data-path="README.md"] > .row').click();
    await expect(surface(page, "设置")).toHaveCount(0);
    await expect(page.locator(".cm-content").first()).toBeVisible();
    await expect(page.locator(".cm-content").first()).toContainText("临时界面回归项目");
    expect(await page.locator(".center-stack").evaluate((element) => element.inert)).toBe(false);
  } else if (mode(testInfo) === "tablet") {
    await page.setViewportSize({ width: 1440, height: 950 }); await painted(page);
    await settings.click(); await assertSide(page, "设置", "right", baselines);
    // 完整模态侧栏阻止背景操作；关闭后才允许打开文件。
    const fileButton = page.getByRole("button", { name: "显示或隐藏文件面板", exact: true });
    await expect(fileButton.click({ trial: true, timeout: 700 })).rejects.toThrow(/Timeout|intercepts pointer events|not receive pointer/);
    await expect(app(page)).not.toHaveClass(/files-open/);
    await closeTop(page); await assertClean(page);
    await showFiles(page); await page.locator('.node[data-path="README.md"] > .row').click();
    await expect(page.locator(".cm-content").first()).toBeVisible();
    await expect(page.locator(".cm-content").first()).toContainText("临时界面回归项目");
    expect(await page.locator(".center-stack").evaluate((element) => element.inert)).toBe(false);
    await assertCenterUnchanged(page, baselines);
  }

  if (mode(testInfo) === "tablet") { await page.setViewportSize(testInfo.project.use.viewport); await painted(page); }
  const workbenchButton = page.getByRole("button", { name: "创作工作台", exact: true });
  await workbenchButton.click();
  await expect(page.locator(".studio-workbench")).toBeVisible();
  if (mode(testInfo) === "desktop") {
    await expect(surface(page, "创作工作台")).toHaveAttribute("data-placement", "page");
    expect(await surface(page, "创作工作台").evaluate((element) => !!element.closest(".workspace-pages"))).toBe(true);
  } else if (mode(testInfo) === "tablet") {
    const workbenchPanel = surface(page, "创作工作台");
    const back = workbenchPanel.getByRole("button", { name: "返回代码", exact: true });
    await assertSide(page, "创作工作台", "right", baselines);
    // 被 CSS 隐藏的通用标题关闭按钮不能占据首个焦点或截断 Tab 回环。
    await expect(workbenchPanel.locator(".sheet-heading .sheet-close")).toBeHidden();
    await expect(back).toBeFocused();
    const controls = workbenchPanel.locator('button:visible:enabled, input:visible:enabled, textarea:visible:enabled, select:visible:enabled, a[href]:visible, [tabindex]:visible:not([tabindex="-1"])');
    expect(await controls.count()).toBeGreaterThan(1);
    for (const size of tabletSizes) {
      await page.setViewportSize(size); await painted(page);
      await assertSide(page, "创作工作台", "right", baselines);
      await controls.last().focus();
      await page.keyboard.press("Tab"); await expect(back).toBeFocused();
      await page.keyboard.press("Shift+Tab"); await expect(controls.last()).toBeFocused();
      await page.keyboard.press("Tab"); await expect(back).toBeFocused();
    }
  } else {
    await expect(app(page).locator(".center-stack")).toHaveClass(/studio-workbench-open/);
    await expect(surface(page, "创作工作台")).toHaveCount(0);
  }
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("工作台设备呈现.png"), fullPage: true });
  await page.getByRole("button", { name: "返回代码", exact: true }).click();
  await expect(page.locator(".studio-workbench")).toBeHidden();
  await assertClean(page);
});

test("真实菜单、居中确认、键盘焦点与减少动态效果", async ({ page, services }, testInfo) => {
  await bootWorkspace(page, services); await toggleAI(page, false); await showFiles(page);
  const row = page.locator('.node[data-path="README.md"] > .row');
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "README.md", exact: true });
  await expect(menu).toBeVisible();
  if (mode(testInfo) === "desktop") {
    const pop = page.locator(".surface-popover"), p = await geometry(pop), r = await geometry(row), viewport = page.viewportSize();
    expect(p.x).toBeGreaterThanOrEqual(0); expect(p.right).toBeLessThanOrEqual(viewport.width);
    // 右键位置可在行中部；菜单紧邻这次点击坐标，而不是固定出现在行底部。
    expect(p.y).toBeGreaterThanOrEqual(r.y - 8); expect(p.y).toBeLessThanOrEqual(r.bottom + 16);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End"); await expect(menu.getByRole("menuitem").last()).toBeFocused();
    await page.keyboard.press("Home"); await expect(menu.getByRole("menuitem").first()).toBeFocused();
    expect(await app(page).evaluate((element) => element.inert)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("桌面文件右键菜单.png"), fullPage: true });
  } else if (mode(testInfo) === "tablet") {
    await expect(surface(page, "README.md")).toHaveAttribute("data-placement", "sidepane");
    await expect(surface(page, "README.md")).toHaveAttribute("data-side", "left");
  } else await expect(surface(page, "README.md")).toHaveAttribute("data-placement", "bottomsheet");
  await menu.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "重命名", exact: true });
  await expect(dialog).toBeVisible();
  const d = await geometry(dialog), viewport = page.viewportSize();
  expect(Math.abs(d.x + d.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(d.y + d.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);
  expect(await app(page).evaluate((element) => element.inert)).toBe(true);
  await expect(dialog.getByRole("textbox")).toBeFocused();
  await dialog.getByRole("textbox").fill("仅输入不保存.md");
  await dialog.getByRole("button", { name: "重命名", exact: true }).focus();
  await page.keyboard.press("Tab"); await expect(dialog.getByRole("textbox")).toBeFocused();
  const motion = await dialog.evaluate((element) => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationDuration }));
  expect(motion.transition.split(",").every((duration) => parseFloat(duration) <= 0.001)).toBe(true);
  expect(motion.animation.split(",").every((duration) => parseFloat(duration) <= 0.001)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("居中确认.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await app(page).evaluate((element) => element.inert)).toBe(false);
  await expect(page.locator('.node[data-path="README.md"]')).toHaveCount(1);
  await noOverflow(page);
});
