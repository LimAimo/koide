# Koide Native Core 架构

本文描述 0.9.0 起的当前架构，不再是迁移计划。

## 1. 运行时边界

```text
apps/web UI
    │
    ▼
Runtime API（平台无关）
    │
    ├── NativeRuntimeAdapter ── Tauri IPC ── Rust Native Core
    │                                      ├─ workspace/files
    │                                      ├─ checkpoint/trash
    │                                      ├─ permissions/policy
    │                                      ├─ providers/agent
    │                                      ├─ git
    │                                      ├─ terminal/process
    │                                      └─ settings/conversations
    │
    └── BridgeRuntimeAdapter ── WebSocket ── Python Bridge（可选兼容模式）
```

Windows / Android 本地使用选择 NativeRuntimeAdapter，不启动 Python、localhost 或 WebSocket。BridgeRuntimeAdapter 只服务浏览器 / LAN 兼容场景。

## 2. 前端约束

`apps/web/src/components/**` 与 `apps/web/src/main.js` 不允许直接 import `services/bridge.js` 或调用底层传输协议。组件只能使用 `services/runtime/**` 的领域 API，例如：

```js
runtime.files.read({ path })
runtime.files.write({ path, content, base_revision })
runtime.workspace.open({ location })
runtime.git.status()
runtime.terminal.open({ cols, rows })
runtime.agent.start({...})
runtime.on("fs.changed", handler)
```

## 3. Workspace / Files

必须长期保持：

- 工作区沙箱与路径越界防护；
- SHA-256 revision；
- `base_revision` 冲突检测；
- 原子写入与事务式大文件写入；
- tree / search / glob；
- create / delete / rename / copy；
- 用户和 Agent 修改统一产生领域事件；
- 被覆盖与删除内容可恢复。

Workspace backend 当前包含 LocalFS 与 Android SAF。SAF URI 从不伪装成 `PathBuf`。

## 4. Checkpoint / Trash

- 每个 Agent 任务建立 checkpoint；
- 支持单事件、单文件、整任务恢复；
- 删除与破坏性恢复优先经过 Koide 回收站；
- Git 强制恢复也不能绕过 Workspace 安全语义。

## 5. Security

- HardPolicy 是 Core 内部不可绕过的底层规则；
- PermissionEngine 支持 restricted / manual / ai / autonomous；
- 支持逐工具 deny / ask / session / always / ai_review 与 allow/deny 规则；
- UI 不能通过更低级 IPC 绕过 Workspace、HardPolicy 或 Checkpoint。

## 6. Providers / Agent

- HTTP/SSE 由 Rust Core 发起；
- API Key 保存在 Native Core 数据目录，不回传明文；
- OpenAI-compatible、Anthropic、Gemini Native 都有原生调用路径；
- Tool Call、Reasoning、ask_user、审批、停止和会话历史通过 Runtime Event 暴露；
- Provider 停止为协作式检查；同步网络读取被服务端阻塞时可能延迟。

## 7. Git / Terminal

Git 与 Terminal 是 workspace capability：

- Windows LocalFS：Git + PTY；
- Android LocalFS：一次性 shell；当前无交互式 PTY；
- Android SAF：Git=false、terminal_cwd=false，因为 content URI 不是普通 cwd。

UI 必须根据 capability 显示真实能力，不得伪装支持。

## 8. Android SAF

- 通过系统目录选择器获取 tree URI；
- 使用持久化 URI 权限；
- Kotlin plugin 只负责 `ContentResolver` / `DocumentsContract` I/O 原语；
- revision、Checkpoint、Trash、Agent 等业务语义仍由 Rust Core 负责。

详见 `ANDROID_SAF_BACKEND.md`。

### 平台反馈

`plugins/feedback/` 是独立于 SAF 文件 I/O 的 Android 触觉插件。UI 经 Runtime `feedback.emit` 发送限定的语义事件，Rust 校验类型，Kotlin 使用系统 `View.performHapticFeedback`；不申请振动权限、不忽略系统设置、不接受任意波形。非 Android 与 Bridge 明确返回不支持，不将可选反馈失败当作工程操作失败。契约见 `FEEDBACK.md`。

## 9. 数据与兼容

平台级设置、profiles、secrets、device data 和 global instructions 使用平台应用数据目录。项目内部仍保留既有 `.diffusion` / `diffusion-*` 命名时，以兼容历史数据为优先，不因产品改名破坏已有项目。

## 10. 测试门槛

行为变化至少覆盖对应的 Web/Rust/Bridge 单测或集成测试；文件破坏性操作必须额外覆盖越界、revision conflict 和恢复路径。主 CI 同时构建 Windows 与 Android。
