# Koide 0.11.0 界面验收

## 本机验证范围

2026-10-08 在 Windows 上使用真实 Edge、临时 Bridge 和临时项目验证。没有使用用户项目、模型密钥或付费模型。测试退出时关闭自己的 Bridge 进程树与预览服务，清理临时项目；不结束无关进程。

| 验证 | 结果 | 范围 |
|---|---|---|
| Web 自动测试 | 145 通过、1 平台跳过 | 共 146 项，含布局、历史返回竞态、焦点、文件并发打开与终端生命周期 |
| Bridge | 85 通过、2 平台跳过 | 共 87 项，Windows Python Bridge 明确不提供 PTY |
| Native Core | 40 通过 | 39 项常规测试，加真实 Edge 截图隔离实验 |
| 真实响应式浏览器 | 24 通过 | 原有 6 项预览回归，加 6 种屏幕尺寸的 18 项交互回归 |
| 真实桌面专项 | 1 通过 | 标签双击、方向键、右键、分屏、实际 Ctrl 快捷键 |
| Runtime 方法覆盖 | 84 / 84 | 领域 API 与 Native dispatch 保持一致 |

桌面配置为 1440×950、900×760；触控平板模拟为 768×1024、1024×768；手机模拟为 390×844、320×740。实际点击、拖动、键盘和测量覆盖分栏极限、宽度保存、表单节点与焦点保留、侧栏左右方向、推开/覆盖、模式切换清理、菜单与确认框历史导航、点击文件回到编辑器。桌面专项使用真实 CodeMirror 6 和两个临时文件验证左右/上下分屏重排。

截图复核修复了设置竖排标签被固定高度撑开的空白，以及最窄 AI 面板模式按钮遮挡；最小宽度下四种 AI 模式均可见。减少动态效果下确认框与侧栏遵守系统偏好，手机触控入口维持至少 40px。

## 原生交付检查

Windows 安装器由 `pnpm native:build` 生成，路径为 `apps/native/src-tauri/target/release/bundle/nsis/Koide_0.11.0_x64-setup.exe` 和 `bundle/msi/Koide_0.11.0_x64_zh-CN.msi`。二进制与编辑器产物保持在忽略目录，不进入 Git。

`tests/browser/native-smoke.mjs` 使用独立 WebView2 缓存执行只读启动检查，验证版本、Native IPC、中文 TypeScript 诊断、CSP，以及从打包协议读取的 13 个界面资源与当前源码的 SHA-256 一致性。报告包含实际 EXE 的 SHA-256、大小、时间与截图，避免以旧二进制代替最终交付验证。

最终 Windows EXE 已通过真实 WebView2 启动检查：Native 在线，版本 0.11.0，13 个打包资源全部与源码一致，真实语言 Worker 返回中文 TypeScript 2322，CSP 阻止测试用内联脚本。EXE 大小为 19,678,720 字节，SHA-256 为 `a52cf6734f57de629e8bb7a63d8fb7fcc8e481c3dae050f58a9bddbc1aea1e5d`。MSI 与 NSIS 均成功生成；测试启动的应用已关闭。

## 平台边界

本轮不含 Android 0.11.0 APK、实体手机 / 平板或 iPad WebKit 验收；触控浏览器模拟不能代替这些检查。Android versionCode 已统一到 11000。Windows Bridge 的交互式 PTY 能力降级经过真实回归，终端调高和容器同步另有布局 / 生命周期测试；本轮只读 Native 启动检查不会打开项目或修改应用私有记录。

操作说明见 [桌面与平板界面](RESPONSIVE_UI.md)，组件契约见 [自适应页面与弹层](RESPONSIVE_SURFACES.md)，执行命令见 [浏览器回归](../tests/browser/README.md)。
