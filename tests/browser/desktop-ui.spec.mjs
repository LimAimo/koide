import { test, expect, bootWorkspace } from "./fixtures.mjs";

const tab = (page, path) => page.locator(`.tab-strip .tab[data-path="${path}"]`);
const row = (page, path) => page.locator(`.node[data-path="${path}"] > .row`);
const width = (locator) => locator.evaluate((element) => element.getBoundingClientRect().width);
async function drag(page, locator, dx) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(startX, y); await page.mouse.down();
  await page.mouse.move(Math.max(2, Math.min(page.viewportSize().width - 2, startX + dx)), y, { steps: 8 });
  await page.mouse.up();
}
async function activeTab(page, path) {
  await expect(tab(page, path)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, path)).toHaveJSProperty("tabIndex", 0);
  await expect(tab(page, path).getByRole("button", { name: "关闭标签页", exact: true })).toHaveJSProperty("tabIndex", 0);
  const others = page.locator(`.tab-strip .tab:not([data-path="${path}"])`);
  for (const other of await others.all()) {
    await expect(other).toHaveJSProperty("tabIndex", -1);
    await expect(other.getByRole("button", { name: "关闭标签页", exact: true })).toHaveJSProperty("tabIndex", -1);
  }
}

test("桌面真实双击固定文件、标签键盘操作、容器分屏与快捷键", async ({ page, services }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bootWorkspace(page, services);
  await expect(page.locator("#app")).toHaveAttribute("data-layout", "desktop");
  const files = page.getByRole("button", { name: "显示或隐藏文件面板", exact: true });
  const ai = page.getByRole("button", { name: "显示或隐藏 AI 面板", exact: true });
  if (await files.getAttribute("aria-pressed") !== "true") await files.click();
  if (await ai.getAttribute("aria-pressed") === "true") await ai.click();

  // 用真正的双击固定临时项目文件，第二个文件不能替换第一个预览标签。
  await row(page, "README.md").dblclick();
  await expect(tab(page, "README.md")).toBeVisible();
  await expect(tab(page, "README.md")).not.toHaveClass(/\bpreview\b/);
  await row(page, "example.ts").dblclick();
  await expect(tab(page, "example.ts")).not.toHaveClass(/\bpreview\b/);
  await expect(page.locator(".tab-strip .tab")).toHaveCount(2);
  await activeTab(page, "example.ts");
  await expect(page.locator(".cm-content").first()).toContainText("你好，Koide");

  await tab(page, "example.ts").focus();
  await page.keyboard.press("ArrowLeft"); await activeTab(page, "README.md"); await expect(tab(page, "README.md")).toBeFocused();
  await page.keyboard.press("ArrowRight"); await activeTab(page, "example.ts"); await expect(tab(page, "example.ts")).toBeFocused();
  await page.keyboard.press("Home"); await activeTab(page, "README.md"); await expect(tab(page, "README.md")).toBeFocused();
  await page.keyboard.press("End"); await activeTab(page, "example.ts"); await expect(tab(page, "example.ts")).toBeFocused();

  // 键盘与鼠标打开同一个标签操作菜单，关闭后焦点仍在来源标签。
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "example.ts", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator(".surface-popover")).toHaveCount(0);
  await expect(tab(page, "example.ts")).toBeFocused();
  await tab(page, "README.md").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "README.md", exact: true });
  await expect(menu).toBeVisible(); await menu.getByRole("menuitem", { name: "在分屏中打开", exact: true }).click();
  await expect(page.locator(".editors > .epane")).toHaveCount(2);
  await expect(page.locator(".epane.split")).toBeVisible();
  await expect(page.locator(".editors")).not.toHaveClass(/\bv\b/);
  await expect(page.locator(".epane.split .cm-content")).toContainText("临时界面回归项目");

  // 真正调整两侧分栏，分屏方向按编辑器容器宽度变化，而非设备宽度。
  await page.keyboard.press("Control+2"); await expect(ai).toHaveAttribute("aria-pressed", "true");
  const r1 = page.getByRole("separator", { name: "调整文件面板宽度", exact: true });
  const r2 = page.getByRole("separator", { name: "调整 AI 面板宽度", exact: true });
  await drag(page, r1, 180); await drag(page, r2, -120);
  await expect.poll(() => width(page.locator(".editor-pane"))).toBeLessThan(700);
  await expect(page.locator(".editors")).toHaveClass(/\bv\b/);
  await page.screenshot({ path: testInfo.outputPath("窄编辑区上下分屏.png"), fullPage: true });
  await drag(page, r1, -240); await drag(page, r2, 300);
  await expect.poll(() => width(page.locator(".editor-pane"))).toBeGreaterThanOrEqual(700);
  await expect(page.locator(".editors")).not.toHaveClass(/\bv\b/);
  await page.screenshot({ path: testInfo.outputPath("宽编辑区左右分屏.png"), fullPage: true });

  await tab(page, "example.ts").focus();
  await page.keyboard.press("Control+1"); await expect(files).toHaveAttribute("aria-pressed", "false"); await expect(page.locator(".files")).toBeHidden();
  await page.keyboard.press("Control+1"); await expect(files).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".files")).toBeVisible();
  await page.keyboard.press("Control+2"); await expect(ai).toHaveAttribute("aria-pressed", "false"); await expect(page.locator(".ai")).toBeHidden();
  await page.keyboard.press("Control+2"); await expect(ai).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".ai")).toBeVisible();
  await page.keyboard.press("Control+,");
  const settings = page.locator('.settings-surface[data-placement="page"]');
  await expect(settings).toBeVisible(); await expect(page.locator(".editor-pane")).toBeHidden();
  expect(await page.locator("#app").evaluate((element) => element.inert)).toBe(false);
  await page.keyboard.press("Escape"); await expect(settings).toHaveCount(0); await expect(page.locator(".editor-pane")).toBeVisible();
  await expect(page.locator(".tab-strip .tab")).toHaveCount(2); await activeTab(page, "example.ts");
  await expect(page.locator(".epane.split")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
