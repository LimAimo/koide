import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// 独立于 Bridge 测试：只检查原生启动和只读 IPC，不打开项目或更改安全设置。
if (process.platform !== "win32") throw new Error("此脚本需要 Windows WebView2");
const executable = path.resolve(process.argv[2] || "apps/native/src-tauri/target/release/diffusion-native.exe");
await access(executable);
const executableStat = await stat(executable);
const artifact = { sha256: createHash("sha256").update(await readFile(executable)).digest("hex"), bytes: executableStat.size, modifiedAt: executableStat.mtime.toISOString() };
const startedAt = new Date().toISOString();
const output = await mkdtemp(path.join(os.tmpdir(), "koide-native-smoke-"));
const profile = path.join(output, "webview-profile");
const listener = net.createServer();
listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
// WebView2 对提升权限的宿主忽略环境调试参数；官方命令行通道也传入同一 localhost 端口。
const browserArguments = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 ${process.env.KOIDE_TEST_WEBVIEW_ARGS || ""}`;
const child = spawn(executable, [`--edge-webview-switches=${browserArguments}`], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments },
});
let browser, launchError, launchLog = "";
child.stdout.on("data", (chunk) => { launchLog = (launchLog + chunk).slice(-16000); });
child.stderr.on("data", (chunk) => { launchLog = (launchLog + chunk).slice(-16000); });
child.on("error", (error) => { launchError = error; });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (launchError || child.exitCode !== null) throw new Error(`原生应用启动失败：${launchError?.message || child.exitCode}\n${launchLog}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* 等待 WebView2 */ }
    if (Date.now() > deadline) throw new Error(`WebView2 没有开放测试用 CDP；未验证原生启动。EXE PID：${child.pid}，CDP 端口：${port}，日志：${launchLog || "无标准错误输出"}`);
    await pause(100);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  while (!page) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
    if (!page && Date.now() > deadline) throw new Error("CDP 未找到 Koide 主界面");
    if (!page) await pause(100);
  }
  await page.waitForFunction(() => globalThis.__KOIDE_BOOT_OK__ === true, undefined, { timeout: 15000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(output, "启动失败.png"), fullPage: true });
    const diagnostic = await page.locator("#boot-error").textContent().catch(() => "没有启动诊断");
    throw new Error(`${error.message}\n启动诊断：${diagnostic}\n截图目录：${output}`);
  });
  await page.locator('.capsule[data-state="online"]').waitFor({ state: "visible", timeout: 15000 });
  const result = await page.evaluate(async () => {
    const { runtime, state } = await import("/src/services/app.js");
    const hello = await runtime.call("hello");
    let missingMethod;
    try { await runtime.call("test.nonexistent"); } catch (error) { missingMethod = error.code; }
    return {
      boot: globalThis.__KOIDE_BOOT_OK__, runtime: runtime.kind, connection: state.get().conn,
      native: hello.native, version: hello.version, workspace: hello.workspace === null,
      capsule: document.querySelector(".capsule .txt")?.textContent,
      missingMethod, bootFallback: !!document.getElementById("boot-fallback"),
      csp: Array.from(document.querySelectorAll("meta[http-equiv]")).find((meta) => meta.httpEquiv.toLowerCase() === "content-security-policy")?.content || "",
    };
  });
  assert.equal(result.boot, true);
  assert.equal(result.runtime, "native");
  assert.equal(result.connection, "online");
  assert.equal(result.native, true);
  assert.equal(result.workspace, true);
  assert.equal(result.missingMethod, "METHOD_NOT_IMPLEMENTED");
  assert.equal(result.bootFallback, false);
  assert.equal(result.capsule, "本地环境已就绪");
  const language = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker(new URL("/vendor/language.js", location.href), { type: "module" });
    const finish = (error, result) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error("发行版语言 Worker 运行超时")), 20000);
    worker.onerror = (event) => finish(new Error(event.message || "发行版语言 Worker 加载失败"));
    worker.onmessage = ({ data }) => { if (data.id === 1) finish(data.error ? new Error(data.error) : null, data.result); };
    worker.postMessage({ id: 1, operation: "diagnostics", files: [{ path: "wrong.ts", content: 'const amount: number = "不是数字";', revision: "1" }] });
  }));
  const typeError = language.issues?.find((issue) => Number(issue.code) === 2322);
  assert.ok(typeError, "真实语言 Worker 应返回 TypeScript 2322");
  assert.match(typeError.message, /不能将类型/);
  const probe = await page.evaluate(async () => {
    let directive, policy;
    const listener = (event) => { directive = event.effectiveDirective; policy = event.originalPolicy; };
    document.addEventListener("securitypolicyviolation", listener);
    const script = document.createElement("script");
    script.textContent = "globalThis.__KOIDE_CSP_INLINE_PROBE__ = true";
    document.head.append(script);
    await new Promise((resolve) => setTimeout(resolve, 150));
    script.remove(); document.removeEventListener("securitypolicyviolation", listener);
    return { blocked: globalThis.__KOIDE_CSP_INLINE_PROBE__ !== true, directive, policy };
  });
  assert.equal(probe.blocked, true);
  assert.match(probe.directive, /^script-src/);
  // Tauri 可通过响应头下发 CSP；使用真实违规事件取得生效策略，不能只依赖 meta。
  result.csp ||= probe.policy;
  assert.match(result.csp, /script-src[^;]*'self'/);
  await page.screenshot({ path: path.join(output, "原生启动.png"), fullPage: true });
  const report = { ...result, languageWorker: { code: typeError.code, message: typeError.message }, cspProbe: probe, executable, artifact, startedAt, finishedAt: new Date().toISOString(), screenshot: path.join(output, "原生启动.png") };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("原生真实 WebView2 启动、Runtime IPC、语言 Worker 与 CSP 检查通过");
  console.log(JSON.stringify({ boot: result.boot, runtime: result.runtime, connection: result.connection, version: result.version, capsule: result.capsule, missingMethod: result.missingMethod, languageWorker: report.languageWorker, cspBlocked: probe.blocked, cspDirective: probe.directive, artifact, report: path.join(output, "report.json"), screenshot: report.screenshot }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    const exited = once(child, "exit").catch(() => {});
    child.kill();
    await Promise.race([exited, pause(5000)]);
  }
  // 只清理本次生成的 WebView2 测试缓存，保留报告和截图供复核。
  if (path.dirname(profile) === output) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
