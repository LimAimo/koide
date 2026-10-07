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
    { name: "桌面", use: { viewport: { width: 1440, height: 950 } } },
    { name: "手机", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
