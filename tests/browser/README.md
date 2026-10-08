# 真实浏览器回归

先安装项目依赖并构建正式编辑器：

```powershell
pnpm install
pnpm build:cm6
pnpm exec playwright test --config tests/browser/playwright.config.mjs
```

Windows 默认使用已安装的 Microsoft Edge；其他系统先执行 `pnpm exec playwright install chromium`。可通过 `KOIDE_TEST_BROWSER` 指定浏览器路径，通过 `KOIDE_TEST_PYTHON` 指定 Python 解释器。

测试自动建立临时项目、独立 Bridge 数据目录和本机 HTTP 演示服务。不调用 Agent，不修改真实项目；Windows Store Python 启动器及解释器子进程按本测试拥有的 PID 树清理，其他系统正常结束测试进程。清理失败会导致测试失败。

`workbench.spec.mjs` 覆盖桌面与手机的预览元素选取、刷新后继续选取、聊天上下文、日志与问题分流，以及 iframe / 消息来源隔离。`responsive.spec.mjs` 使用 1440 / 900px 桌面、768px 竖屏 / 1024px 横屏触控平板、390 / 320px 手机六种真实浏览器上下文，检查分栏拖动与键盘调整、中央编辑器最小宽度、宽度持久化、平板768 / 1024 / 1440px左右方向与始终覆盖、编辑区位置和尺寸不变、文件 / AI单侧互斥、跨模式输入节点与焦点保留、关闭后的焦点及 inert 恢复、手机 AI 高度拖动、锚定右键菜单、居中确认与减少动态效果。页面用例同时检查工作台的桌面主区域 / 平板右侧 / 手机呈现，以及桌面点击文件后离开设置并回到可见编辑器、宽触控平板在模态设置中阻止背景文件操作且关闭后恢复；Windows Bridge 的终端验证检查实际 `NO_PTY` 降级，不制造假会话。

平板工作台还检查首次焦点落在“返回代码”，以及 768 / 1024 / 1440px 下 Tab / Shift+Tab 在可见控件间回环；文件 / AI 关闭后焦点返回触发按钮，AI 由真实工作台通知自动展开后关闭则返回编辑器。

只跑响应式回归：

```powershell
pnpm exec playwright test --config tests/browser/playwright.config.mjs responsive.spec.mjs
```

项目名称以「响应式」开头的六个项目只运行响应式用例，原有预览用例维持桌面 / 手机两种上下文，避免额外重复。平板上下文同时设定触控输入与物理屏幕尺寸，横竖屏切换时不会被误判为放大的手机。

`desktop-ui.spec.mjs` 仅运行于「桌面」项目，覆盖真实双击固定文件、标签左右 / Home / End 键与焦点顺序、Shift+F10 和右键操作菜单、按实际编辑器容器宽度重排分屏，以及 Ctrl+1 / Ctrl+2 / Ctrl+, 快捷键和 Escape 返回编辑器。

```powershell
pnpm exec playwright test --config tests/browser/playwright.config.mjs --project=桌面 desktop-ui.spec.mjs
```

成功截图及失败追踪默认保存在系统临时目录的 `koide-browser-results` 中，可通过 `KOIDE_TEST_OUTPUT` 指定其他结果目录。

Windows 原生发行版生成后，可执行只读启动验证：

```powershell
node tests/browser/native-smoke.mjs apps/native/src-tauri/target/release/diffusion-native.exe
```

该脚本使用独立 WebView2 缓存，验证真实 Tauri IPC、界面启动、当前版本、打包界面资源与已验证源码的 SHA-256 一致性、发行版语言 Worker 的中文 TypeScript 诊断和 CSP 对无 nonce 内联脚本的阻止；不打开项目、不修改设置。Native Core 仍使用应用配置的安全数据目录，脚本不改写其中的记录。验证后关闭本次启动的应用，报告与截图保存在系统临时目录。

脚本同时使用 WebView2 官方的 `--edge-webview-switches` 调试参数通道。提升权限的 Windows 宿主会忽略环境变量中的调试参数，见 [Microsoft WebView2 安全说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) 与 [AdditionalBrowserArguments 官方接口说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions)。测试不修改系统注册表，不关闭 iframe、CSP 或浏览器沙箱。
