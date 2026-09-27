# Koide 1.0.0-rc.1 当前状态

Koide 当前版本标识为 `1.0.0-rc.1`，处于 `dev/1.0.0` 候选版准备阶段，尚未发布。0.9.0 仍是 `main` 的稳定基线；**Native Runtime 是本地应用的主路径**；Python Bridge 保留为浏览器与 LAN 兼容模式，不再是 Windows / Android 本地使用的前置条件。

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

## 1.0 UI Motion System

- 普通 UI 使用统一 motion tokens：即时反馈 70ms、快速 160ms、中等 240ms、容器/抽屉 320ms、页面级 360ms。
- 按钮按压、文件抽屉、AI Bottom Sheet、Dialog、Toast、页面切换、聊天/工具卡、工作现场与 Time Machine 使用同一套 easing/时长层级。
- AI Bottom Sheet 的释放使用可中断阻尼弹簧，半屏/全屏吸附与自由高度共存；取消手势恢复原位，停顿后释放不沿用旧速度。
- 浮层关闭立即更新交互和返回栈，退出动画结束后卸载 DOM；连点关闭后重开不会被旧返回事件误关。工作现场按稳定节点更新，工具状态图标连续过渡。
- 系统或 Koide 的 reduced-motion 设置覆盖普通 UI；触屏把手、小按钮和文件行至少 40px。
- Diffusion 代码编辑动画属于内容变化可视化，继续使用独立动画引擎，不与导航/控件 Motion tokens 混用。

## 1.0 Agent 可观测性

- **工作现场**：只根据真实 Agent 事件推进阶段；没有发生的探索/修改/验证会标记为「未经过」。
- **Time Machine**：Native 与 Bridge 新任务都会把 checkpoint 节点关联到真实 Tool Call `call_id`；读取、文件修改、`web_fetch` 与 `shell_run` 验证均可追踪。
- **Rich Diff**：文件级逐步累计增删统计（含撤销记录）、旧/新行号、修改范围、区域跳转与独立动画重播。二进制、过大文本或缺失历史不伪造数据。
- **历史快照**：Native / Bridge 新修改保存 `after_blob`；旧记录只接受匹配 `after_rev` 的历史候选或当前文件，否则明确报错。
- **验证故事线**：按同一命令与 cwd 关联失败/通过，区分无修改重试、修改后通过、通过后又有修改或撤销；可跳转对应事件。
- **项目记忆**：`.koide/PROJECT_MEMORY.md` 由用户显式维护并进入 Native/Bridge Agent 上下文；revision 冲突不会覆盖用户编辑框里的未保存内容。

## Runtime API

UI 只通过 `apps/web/src/services/runtime/` 调用领域能力。当前 Native dispatch 覆盖全部 72 个业务方法；其中 `devices.pair_code` 在 Native 模式明确返回 `LAN_OFF`，因为 Native LAN server 尚未提供。这是有意的 capability，而不是静默假实现。

## Android SAF

SAF 后端已进入 0.9.0 主线并通过 Android CI 编译与 APK 签名验证。它支持原地 tree/read/write/patch/create/delete/rename/copy、search/glob、large write、Checkpoint、Trash、Export 和项目 `AGENTS.md`。不同厂商 DocumentsProvider 仍建议持续做真机回归。

## Provider

OpenAI-compatible、Anthropic 与 Gemini Native 均有 Agent 调用路径；交互式 Agent 使用流式文本/思考事件。停止请求在读循环之间会检查，但同步 HTTP 读取被服务端长时间阻塞时，停止可能延迟到本次读取返回。

## 兼容模式

`bridge/`、`pyproject.toml` 与 Bridge tests 继续保留，因为：

1. 浏览器运行需要一个受控执行端；
2. LAN 配对 / 远程项目目前由 Python Bridge 提供；
3. Bridge 仍是协议与回归兼容层。

如果以后加入 Rust Remote Runtime，可以再决定是否删除 Bridge；1.0 不把这件事作为正式发布的前提。

## RC 状态

Product Polish 提交 `5a5bf1271e63b3b257e0ce5e4f30069633396cee` 的 [Stable Build #105](https://github.com/LimAimo/Diffusion-IDE/actions/runs/36324930485) 已逐项核对 Job/Step：Web UI + CodeMirror 6、Bridge、Native Core、Windows x64、Android ARM64 均通过，Release 步骤跳过。后续版本标识收尾提交以自己的 CI 为准，不能复用这次通过结论。

已同步候选版版本号与 Android `versionCode=10001`，未发布 RC、未合并 `main`。前三块核心实现（面板物理交互、连续状态、Rich Diff）已提交；触觉/声音未接入，全局重复入口/信息密度收敛和设备验收尚未全部完成。Android 真机手感、安全区、软键盘和 SAF 提供商差异仍需验收。1.x 功能均为后续计划。详见 [产品打磨记录](PRODUCT_POLISH.md) 和 [1.x 路线](ROADMAP.md)。
