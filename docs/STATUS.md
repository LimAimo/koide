# Koide 0.9.0 当前状态

Koide 0.9.0 已从预发布阶段转为正式版本。**Native Runtime 是本地应用的主路径**；Python Bridge 保留为浏览器与 LAN 兼容模式，不再是 Windows / Android 本地使用的前置条件。

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

如果以后加入 Rust Remote Runtime，可以再决定是否删除 Bridge；0.9.0 不把这件事作为正式发布的前提。
