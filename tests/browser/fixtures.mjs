import { test as base, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const python = process.env.KOIDE_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
async function freePort() { const server = net.createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
async function bounded(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`清理超时：${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}

const demo = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览回归样例</title>
<style>body{margin:0;padding:24px;font-family:system-ui;background:#f5f4fa;color:#27203d}h1{font-size:28px;padding:12px;background:#e9e3fa;border-radius:12px}button{min-height:44px;padding:12px 16px;margin:6px 0;border:0;border-radius:10px;background:#6d4dd2;color:white;font-size:16px;display:block}p{line-height:1.7}</style>
<h1 id="title">能被选择的页面标题</h1><p>这是独立本机服务中的产品页面。</p><button id="action">普通页面操作</button><button id="info">输出普通日志</button><button id="error">输出真实错误</button>
<script>document.querySelector('#action').onclick=()=>{document.body.dataset.clicked='yes'};document.querySelector('#info').onclick=()=>{console.log('普通日志样例');console.info('普通信息样例')};document.querySelector('#error').onclick=()=>console.error('预览错误样例');console.info('页面就绪样例');</script></html>`;

export const test = base.extend({
  services: [async ({}, use) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "koide-browser-test-"));
    const project = path.join(temp, "project"), data = path.join(temp, "data");
    await mkdir(project);
    // 仅建立临时样例。测试过程中的产品写入均通过真正的 Runtime / Workspace。
    await writeFile(path.join(project, "README.md"), "# 临时界面回归项目\n\n响应式编辑器样例。\n");
    await writeFile(path.join(project, "example.ts"), "export const message: string = '你好，Koide';\n");
    const product = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(demo);
    });
    const demoPort = await listen(product), bridgePort = await freePort();
    const origin = `http://127.0.0.1:${bridgePort}`;
    const child = spawn(python, ["-u", path.join(root, "bridge/main.py"), "--port", String(bridgePort), "--web-dir", path.join(root, "apps/web"), "--data-dir", data, "--workspace", project], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let log = "", launchError;
    child.stdout.on("data", (chunk) => { log = (log + chunk).slice(-16000); });
    child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-16000); });
    child.on("error", (error) => { launchError = error; });
    try {
      const deadline = Date.now() + 20000;
      while (true) {
        if (launchError || child.exitCode !== null) throw new Error(`临时 Bridge 启动失败：${launchError?.message || child.exitCode}\n${log}`);
        try { const response = await fetch(`${origin}/api/info`); await response.arrayBuffer(); if (response.ok) break; } catch { /* 等待服务监听 */ }
        if (Date.now() > deadline) throw new Error(`临时 Bridge 启动超时：${python}\n${log}`);
        await pause(100);
      }
      await use({ origin, productUrl: `http://127.0.0.1:${demoPort}`, project });
    } finally {
      const errors = [], clean = async (action) => { try { await action(); } catch (error) { errors.push(error); } };
      await clean(async () => {
        let stopError;
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          // Windows Store Python 启动器还有解释器子进程，只结束本测试拥有的 PID 树。
          if (process.platform === "win32") {
            try { await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); }
            catch (error) { stopError = error; }
          }
          else child.kill("SIGINT");
        }
        // 进程可在判断与 taskkill 之间退出；仅在进程和继承输出管道确实关闭后容忍这项竞态。
        try { await bounded(closed, `Bridge ${child.pid} 及输出管道关闭`); }
        catch (error) { throw stopError || error; }
      });
      await clean(async () => { product.closeAllConnections(); await bounded(new Promise((resolve, reject) => product.close((error) => error ? reject(error) : resolve())), "临时预览 HTTP 服务关闭"); });
      await clean(async () => {
        const resolved = path.resolve(temp);
        if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("koide-browser-test-")) throw new Error("临时目录边界验证失败");
        await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      if (errors.length) throw new AggregateError(errors, "浏览器回归资源清理失败");
    }
  }, { scope: "worker" }],
});

export async function bootWorkspace(page, services) {
  await page.goto(services.origin);
  await page.waitForFunction(() => globalThis.__KOIDE_BOOT_OK__ === true);
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import("/src/services/app.js");
    const { studioState } = await import("/src/services/studio.js");
    const s = studioState.get();
    return state.get().conn === "online" && !!state.get().workspace && !s.loading && !!s.revision;
  })).toBe(true);
}

export { expect };
