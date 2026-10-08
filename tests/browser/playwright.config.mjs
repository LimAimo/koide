import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Windows 优先使用已安装的 Edge；其他环境使用 Playwright 的 Chromium。
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const executablePath = process.env.KOIDE_TEST_BROWSER || (process.platform === "win32" && existsSync(edge) ? edge : undefined);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "**/*.spec.mjs",
  outputDir: process.env.KOIDE_TEST_OUTPUT || path.join(os.tmpdir(), "koide-browser-results"),
  timeout: 60000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "桌面", testIgnore: "**/responsive.spec.mjs", use: { viewport: { width: 1440, height: 950 } } },
    { name: "手机", testIgnore: ["**/responsive.spec.mjs", "**/desktop-ui.spec.mjs"], use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "响应式桌面1440", testMatch: "**/responsive.spec.mjs", metadata: { device: "desktop" }, use: { viewport: { width: 1440, height: 950 } } },
    { name: "响应式桌面900", testMatch: "**/responsive.spec.mjs", metadata: { device: "desktop" }, use: { viewport: { width: 900, height: 760 } } },
    { name: "响应式平板竖屏", testMatch: "**/responsive.spec.mjs", metadata: { device: "tablet" }, use: { viewport: { width: 768, height: 1024 }, screen: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } },
    { name: "响应式平板横屏", testMatch: "**/responsive.spec.mjs", metadata: { device: "tablet" }, use: { viewport: { width: 1024, height: 768 }, screen: { width: 1024, height: 768 }, isMobile: true, hasTouch: true } },
    { name: "响应式手机390", testMatch: "**/responsive.spec.mjs", metadata: { device: "phone" }, use: { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "响应式手机320", testMatch: "**/responsive.spec.mjs", metadata: { device: "phone" }, use: { viewport: { width: 320, height: 740 }, screen: { width: 320, height: 740 }, isMobile: true, hasTouch: true } },
  ],
});
