# 真实浏览器回归

先安装项目依赖并构建正式编辑器：

```powershell
pnpm install
pnpm build:cm6
pnpm exec playwright test --config tests/browser/playwright.config.mjs
```

Windows 默认使用已安装的 Microsoft Edge；其他系统先执行 `pnpm exec playwright install chromium`。可通过 `KOIDE_TEST_BROWSER` 指定浏览器路径，通过 `KOIDE_TEST_PYTHON` 指定 Python 解释器。

测试自动建立临时项目、独立 Bridge 数据目录和本机 HTTP 演示服务，覆盖桌面与手机的预览元素选取、刷新后继续选取、聊天上下文、日志与问题分流，以及 iframe / 消息来源隔离。不调用 Agent，不修改真实项目。进程和临时项目会在结束时清理。

成功截图及失败追踪默认保存在系统临时目录的 `koide-browser-results` 中，可通过 `KOIDE_TEST_OUTPUT` 指定其他结果目录。

Windows 原生发行版生成后，可执行只读启动验证：

```powershell
node tests/browser/native-smoke.mjs apps/native/src-tauri/target/release/diffusion-native.exe
```

该脚本使用独立 WebView2 缓存，验证真实 Tauri IPC、界面启动、发行版语言 Worker 的中文 TypeScript 诊断和 CSP 对无 nonce 内联脚本的阻止；不打开项目、不修改设置。Native Core 仍使用应用配置的安全数据目录，脚本不改写其中的记录。验证后关闭本次启动的应用，报告与截图保存在系统临时目录。

脚本同时使用 WebView2 官方的 `--edge-webview-switches` 调试参数通道。提升权限的 Windows 宿主会忽略环境变量中的调试参数，见 [Microsoft WebView2 安全说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) 与 [AdditionalBrowserArguments 官方接口说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions)。测试不修改系统注册表，不关闭 iframe、CSP 或浏览器沙箱。
