# Koide 1.0.0 当前状态

Koide 1.0.0 提供独立桌面工作区和平板覆盖侧栏，沿用创作工作台和创作房间。**Native Runtime 是本地应用的主路径**；Python Bridge 保留为浏览器与 LAN 兼容模式，不再是 Windows / Android 本地使用的前置条件。功能用法和实际边界见 [创作工作台](WORKBENCH.md) 与 [桌面和平板操作说明](RESPONSIVE_UI.md)。

## Native 主链

| 能力 | Windows | Android | 说明 |
|---|---|---|---|
| Workspace / Files | ✅ | ✅ | Android 同时支持应用私有目录与 SAF |
| Revision / 冲突检测 | ✅ | ✅ | 写入需要匹配基础 revision |
| Trash / Checkpoint / Time Machine | ✅ | ✅ | SAF 也走同一业务语义 |
| Profiles / Providers | ✅ | ✅ | API Key 由 Native Core 保存 |
| chat / read / edit / agent | ✅ | ✅ | 四种模式均接入 Rust Agent |
| PermissionEngine / HardPolicy | ✅ | ✅ | 含逐工具规则与 AI 审批 |
| Git | ✅ | 视工作区而定 | SAF workspace 明确禁用 Git |
| Terminal | ✅ PTY | ⚠️ | Android 只有一次性 shell，暂无交互 PTY |
| Export | ✅ | ✅ | SAF 会经 backend 遍历生成归档 |
| 外部文件变化 | ✅ | ✅/受 DocumentsProvider 能力影响 | LocalFS 与 SAF 采用不同后端策略 |
| Native LAN Remote Runtime | ❌ | ❌ | 跨设备访问继续使用可选 Python Bridge |

## Runtime API

UI 只通过 `apps/web/src/services/runtime/` 调用领域能力。当前 Native dispatch 覆盖全部 84 个业务方法；其中 `devices.pair_code` 在 Native 模式明确返回 `LAN_OFF`，因为 Native LAN server 尚未提供。这是有意的 capability，而不是静默假实现。

## 创作工作台与氛围

需求与验收卡、真实命令证据、运行向导、受控预览与元素反馈、截图/圈选附件、同基线方案比较、项目记忆、风格卡、JS / TS 语言服务和手机指挥台已经接线。项目数据、重命名和方案应用经过 Workspace / revision / Checkpoint；旧项目的异步结果不能进入新项目。

创作房间提供四种场景、五路本地合成声音、独立音效/动态开关、任务工作灯、锦鲤、心流布局、开工/收工记录、成果明信片和里程碑瓶中世界。声音由点击启动，后台暂停，遵守减少动态设置。

运行向导和隔离方案需要 LocalFS；SAF 支持项目记录和源码指纹，但不会伪装成普通执行目录。截图需要执行端已安装 Edge / Chrome；语言服务当前覆盖 JS / TS，尚未提供其他语言 LSP。预览是 GET / HEAD 隔离代理，完整 WebSocket、表单与跨域应用流程需外部浏览器验证。

## 桌面与平板界面

桌面采用可调宽的文件 / 编辑器 / AI 常驻分栏和可调高终端；完整功能页进入主区域，普通面板与确认居中，菜单锚定入口。平板按触控方式和可用空间独立识别，文件向左、AI 向右，其他侧栏跟随触发入口；侧栏始终覆盖编辑区，不改变其位置和宽度，文件与 AI 侧栏互斥。缩放和横竖屏切换保留输入并清理旧焦点隔离。手机保留自由高度 AI 和全屏设置。

鼠标、键盘、触控和减少动态效果均有回归覆盖；操作方法见 [桌面和平板操作说明](RESPONSIVE_UI.md)。平板模拟和手机浏览器验证不代替实体 Android 平板验收。

## Android SAF

SAF 后端自 0.9.0 起进入主线；历史版本通过 Android CI 编译与 APK 签名验证。它支持原地 tree/read/write/patch/create/delete/rename/copy、search/glob、large write、Checkpoint、Trash、Export 和项目 `AGENTS.md`。本轮在 Windows 验证桌面、触控平板模拟和手机浏览器布局；1.0.0 Android APK 与真机验证仍由 Android CI / 设备回归完成，不能由手机浏览器结果替代。

## Provider

OpenAI-compatible、Anthropic 与 Gemini Native 均有 Agent 调用路径；交互式 Agent 使用流式文本/思考事件。三种协议支持结构化图片消息、真实 token 用量、配置单价估算、预算与重复失败保护。图片需要显式开启模型视觉能力。

Native 的响应头等待、SSE 读取、AI 审批与网页读取使用可取消异步请求，停止信号约每 80ms 检查；`agent.stop` 不等待普通 Core dispatch 锁。终端记录真实退出、超时和取消结果；Windows 取消清理本次命令进程树。文件系统等同步平台操作仍在安全边界完成后退出，不承诺任意操作瞬时中断。

## 兼容模式

`bridge/`、`pyproject.toml` 与 Bridge tests 继续保留，因为：

1. 浏览器运行需要一个受控执行端；
2. LAN 配对 / 远程项目目前由 Python Bridge 提供；
3. Bridge 仍是协议与回归兼容层。

如果以后加入 Rust Remote Runtime，可以再决定是否删除 Bridge；0.10.0 不把这件事作为正式发布的前提。
