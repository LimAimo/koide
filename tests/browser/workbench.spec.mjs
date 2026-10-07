import { test, expect } from "./fixtures.mjs";

async function boot(page, services) {
  await page.goto(services.origin);
  await page.waitForFunction(() => globalThis.__KOIDE_BOOT_OK__ === true);
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import("/src/services/app.js");
    const { studioState } = await import("/src/services/studio.js");
    return state.get().conn === "online" && !!state.get().workspace && !studioState.get().loading && !!studioState.get().revision;
  })).toBe(true).catch(async (error) => {
    const status = await page.evaluate(async () => {
      const { state } = await import("/src/services/app.js");
      const { studioState } = await import("/src/services/studio.js");
      const studio = studioState.get();
      return { connection: state.get().conn, workspace: !!state.get().workspace, loading: studio.loading, revision: studio.revision, error: studio.error };
    });
    throw new Error(`${error.message}\n启动状态：${JSON.stringify(status)}`);
  });
  // 通过可见按钮收起聊天，让手机上的工作台获得完整操作空间。
  if (!(await page.locator("#app").getAttribute("class")).includes("ai-hidden")) await page.getByRole("button", { name: "显示或隐藏 AI 面板", exact: true }).click();
  await page.getByRole("button", { name: "创作工作台", exact: true }).click();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("textbox", { name: "本机开发预览地址" }).fill(services.productUrl);
  await page.getByRole("button", { name: "打开预览", exact: true }).click();
  const frame = page.frameLocator('iframe[title="隔离的产品预览"]');
  await expect(frame.locator("#title")).toBeVisible();
  await expect(page.locator(".studio-body").getByText("预览运行日志", { exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".studio-body details pre").textContent()).toContain("页面就绪样例");
  return frame;
}

async function selections(page) { return page.evaluate(async () => (await import("/src/services/studio.js")).studioState.get().selections); }
async function issues(page) { return page.evaluate(async () => (await import("/src/services/studio.js")).studioState.get().issues); }

test("预览元素经真实控件进入聊天上下文，刷新后选择模式仍有效", async ({ page, services }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const frame = await boot(page, services);
  const picker = page.getByRole("button", { name: "选择页面元素", exact: true });
  await picker.click();
  await expect(page.getByRole("button", { name: "取消元素选择", exact: true })).toHaveAttribute("aria-pressed", "true");
  await frame.locator("#title").click();
  await expect(picker).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await selections(page)).length).toBe(1);
  const first = JSON.parse((await selections(page))[0].text);
  expect(first).toMatchObject({ selector: "#title", tag: "h1", text: "能被选择的页面标题", styles: { fontSize: "28px", padding: "12px" } });
  expect(first.rect.width).toBeGreaterThan(40);

  await picker.click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(frame.locator("#action")).toBeVisible();
  await frame.locator("#action").click();
  await expect.poll(async () => (await selections(page)).length).toBe(2);
  expect(JSON.parse((await selections(page))[1].text).selector).toBe("#action");
  expect(await frame.locator("body").getAttribute("data-clicked")).toBeNull();
  await expect(picker).toHaveAttribute("aria-pressed", "false");

  const smallTargets = await page.locator(".studio-preview-tools button").evaluateAll((buttons) => buttons.map((button) => ({ label: button.textContent, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })).filter((button) => button.width < 40 || button.height < 40));
  expect(smallTargets).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("预览元素.png"), fullPage: true });

  await page.getByRole("button", { name: "显示或隐藏 AI 面板", exact: true }).click();
  await page.getByRole("button", { name: "查看本轮上下文", exact: true }).click();
  const context = page.locator(".studio-context-sheet");
  await expect(context.getByText("选区：预览元素", { exact: true })).toHaveCount(2);
  await context.locator("summary").first().click();
  await expect(context.locator("pre").first()).toContainText('"selector":"#title"');
  await expect(context.locator("pre").first()).toContainText('"styles"');
  expect(await context.locator("pre").first().evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await context.locator("summary").first().evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: testInfo.outputPath("聊天上下文.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("普通预览日志不伪装问题，真实错误进入问题列表", async ({ page, services }) => {
  const frame = await boot(page, services);
  await expect.poll(async () => (await issues(page)).length).toBe(0);
  await frame.locator("#info").click();
  await expect.poll(() => page.locator(".studio-body details pre").textContent()).toContain("普通信息样例");
  await expect.poll(async () => (await issues(page)).length).toBe(0);
  await frame.locator("#error").click();
  await expect.poll(async () => (await issues(page)).map((issue) => issue.message)).toEqual(["预览错误样例"]);
  await page.getByRole("button", { name: "问题", exact: true }).click();
  await expect(page.locator(".studio-body pre")).toHaveText("预览错误样例");
  await expect(page.locator(".studio-body")).not.toContainText("普通日志样例");
});

test("隔离预览不能读取 IDE；伪造来源和 token 的消息被拒绝", async ({ page, services }) => {
  const frame = await boot(page, services);
  await expect(page.locator(".studio-preview-frame")).toHaveAttribute("sandbox", "allow-scripts");
  const isolation = await frame.locator("body").evaluate(() => {
    let denied = false;
    try { void parent.document.body; } catch (error) { denied = error.name === "SecurityError"; }
    return { denied, native: typeof window.__TAURI_INTERNALS__ };
  });
  expect(isolation).toEqual({ denied: true, native: "undefined" });
  await frame.locator("body").evaluate(() => parent.postMessage({ type: "koide.preview", token: "wrong-token", event: "element", data: { selector: "#伪造" } }, "*"));
  await page.evaluate(async () => {
    const { studioState } = await import("/src/services/studio.js");
    window.postMessage({ type: "koide.preview", token: studioState.get().preview.token, event: "element", data: { selector: "#伪造" } }, "*");
  });
  // 消息投递完成后再检查，避免只断言发送前状态。
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await selections(page)).toEqual([]);
  expect(await issues(page)).toEqual([]);
});
