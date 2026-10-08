# Koide 0.10.0 创作工作台验收

本轮在 Windows x64 上实现和验证创作工作台、创作房间以及 Native / Bridge 运行时接线。使用真实文件、命令退出状态、Provider 协议响应和浏览器页面作为证据，不以 AI 的完成声明代替验收。

## 测试入口与结果

| 检查 | 入口 | 本轮结果 |
|---|---|---|
| 正式编辑器与语言引擎构建 | `pnpm build:cm6` | 通过，包含标准库和简体中文 TypeScript 诊断 |
| Web 单元与真实 Bridge UI | `pnpm test:web` | 114 项：113 通过，1 项 Windows Bridge PTY 能力跳过 |
| Bridge 兼容与安全边界 | `pnpm test:bridge` | 87 项：85 通过，2 项 Windows Bridge PTY 能力跳过 |
| Native 领域路由 | `node scripts/check-native-parity.mjs` | 84 / 84，平台限制仍返回明确错误 |
| Rust Core 与真实截图 | `cargo +stable test --lib -- --include-ignored` | 40 / 40，包括本机会话真实 PNG 与越界导航拒绝 |
| 桌面 / 手机真实浏览器 | `pnpm test:browser` | 6 / 6，实际 Edge，1440×950 / 390×844 |
| Native 发行版启动 | `node tests/browser/native-smoke.mjs apps/native/src-tauri/target/release/diffusion-native.exe` | 通过：真实 WebView2、IPC、语言 Worker、CSP 与首页状态检查 |
| Windows 发行构建 | `pnpm native:build` | x64 EXE、简体中文 MSI、简体中文 NSIS |

`pnpm test` 统一构建并发现全部 Bridge / Web 测试，然后运行路由对齐门禁。浏览器测试建立临时项目和独立 Bridge 数据目录；Native 烟测只调用只读接口，不打开项目或改写模型配置。Windows 管理员宿主的 WebView2 调试参数使用微软支持的命令行传入；CSP 可以通过响应头下发，因此检查实际违规事件中的生效策略。

Native 真实截图集成需要已安装的 Edge / Chrome，常规 Rust 测试默认忽略该项；本轮明确使用 `--include-ignored` 执行了这项测试。Bridge 的 Windows PTY 跳过代表明确的 `NO_PTY` 平台能力，实际一次性命令终端和 Rust Windows PTY 已分别验证。

## 关键行为与安全回归

- 元数据并发保存按 revision 串行执行，读取失败不会用空对象覆盖原文件。
- 验证记录包含真实退出、超时、取消与执行前后源码指纹；迟到的验证结果不能向新项目发出通过事件。
- A → B → A 的模块加载、文件读取/保存、图片读取/标注、收工截图、音频启动和语言 Worker 结果均受项目 epoch 隔离；主动切换执行端立即取消旧 RPC，同一执行端自动重连保留未保存内容。
- 批量重命名与方案应用先检查全部路径、规范化别名、HardPolicy、revision、二进制与 Agent 并发状态；基线清单不能通过修改项目文件伪造，冲突拒绝应用，已有修改可从 Checkpoint 恢复。
- 预览要求 opaque iframe、正确窗口来源与随机 token；普通日志不会伪装为问题，真实错误进入问题列表；不转发 IDE 认证信息，不接受 POST 或越界重定向。
- 截图由真实浏览器输出 PNG，页面跳到另一本机端口时目标服务收到 0 次请求。
- 三种 Provider 的视觉附件、用量、预算、重复失败和停止均有协议回归；未知用量保留未知，截断的结构化工具流不会执行工具。
- TypeScript 按符号提供定义、引用和重命名，保留字符串、注释和无关同名变量；真实 Native Worker 返回中文 2322 类型诊断。
- 真实桌面、390px 和 320px 界面检查没有横向溢出；预览、长上下文、A/B 对比、环境音启动/暂停和减少动态设置已实际检查。

浏览器报告和截图默认保存在系统临时目录，详见 [浏览器回归说明](../tests/browser/README.md)。这些测试不会使用正式项目进行方案实验或模型调用。

## 产物与边界

Windows 成品位于 `apps/native/src-tauri/target/release/`：

- `diffusion-native.exe`：可直接启动的原生 EXE。
- `bundle/nsis/Koide_0.10.0_x64-setup.exe`：简体中文安装程序。
- `bundle/msi/Koide_0.10.0_x64_zh-CN.msi`：简体中文 MSI。

最终构建时间为 2026-10-08 02:12（本机时间），文件 SHA-256：

| 产物 | SHA-256 |
|---|---|
| 原生 EXE | `34B8C50BF585885A6A7E78ABEA1BEC21164F308EF576FDBF4F401FEB0D94A4E3` |
| NSIS | `4F15E479C2582A49C4CAEEFB76D72A442F74B030E52864CE9D50F0A04D876E5E` |
| MSI | `37E3DEE85B4BB3069A3A83E0A80D0CCDB2B7A305A17FF6916F1FFD8B616CA127` |

Native 烟测报告记录了同一 EXE 的校验值、大小、时间与首页截图，检查结果绑定最终发行文件。

产物、依赖、Rust target 和自动生成 schema 不纳入源码提交，用户原有 `AGENTS.md` 修改保留。

本轮没有构建 Android 0.10.0 APK 或进行 Android 真机测试；Android 构建和验签保留 CI 门禁。手机浏览器验收不能替代 SAF 的厂商设备验证。运行向导和方案实验限 LocalFS，截图需本机 Edge / Chrome，语言服务目前为 JS / TS；隔离预览尚不支持 WebSocket / HMR、表单提交和跨域应用流程。费用依据配置单价估算，审批模型单独计费且未纳入工作台用量；单次请求可能超过预算。

功能操作与容量边界见 [创作工作台](WORKBENCH.md)，平台能力见 [当前状态](STATUS.md)。
