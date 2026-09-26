# Diffusion Native Core 重构 SPEC

> 目标版本：v0.8.x（迁移期） → v0.9.0（Python Bridge 完全移除）  
> 本文是本次原生化重构的约束文档。实现若与本文冲突，以“核心安全语义不退化、桌面/Android 都是一等公民”为最高原则。

## 1. 目标

Diffusion 从“网页 UI + Python Bridge + WebSocket”重构为“跨平台 UI + Rust Native Core”。

最终正常本地使用路径必须满足：

- 不安装 Python；
- 不启动 Python 进程；
- 不依赖 localhost / 8765；
- 不依赖 WebSocket 才能打开本地项目；
- Windows 桌面端安装后可直接打开项目；
- Android APK 安装后可直接管理本地项目；
- 文件写入、Revision、Checkpoint、回收站、权限硬规则不能因为迁移而弱化；
- 远程连接保留，但降级为可选能力，不能再是 Diffusion 工作的前提。

## 2. 非目标

本次原生化第一阶段不承诺：

- Android 能直接运行所有桌面开发工具链（Docker、MSVC、完整 Node/Cargo 等）；
- 一次迁移就完成所有 73 个旧 RPC 的 Rust 实现；
- 继续维护 Python Bridge 作为长期核心实现。

迁移期允许旧 Bridge 作为兼容适配器存在，但 UI 不得继续直接依赖它。

## 3. 最终架构

```text
apps/web UI
    │
    ▼
Runtime API（平台无关）
    │
    ├── NativeRuntimeAdapter ── Tauri IPC ── Rust Core
    │                                      ├─ workspace/files
    │                                      ├─ checkpoint/trash
    │                                      ├─ permissions/policy
    │                                      ├─ providers/agent
    │                                      ├─ git
    │                                      ├─ terminal/process
    │                                      └─ settings/conversations
    │
    └── RemoteRuntimeAdapter（可选）── WebSocket ── Remote Host
```

迁移期额外存在：

```text
BridgeRuntimeAdapter ── 旧 Python Bridge
```

它只用于过渡和回归验证，不能成为新 UI 的直接依赖。

## 4. 前端边界

`apps/web/src/components/**`、`apps/web/src/main.js` 不允许：

- import `services/bridge.js`；
- 直接调用 `bridge.rpc(...)`；
- 直接调用 `Bridge.pair(...)`；
- 假定存在 `127.0.0.1:8765`。

组件只能使用 `services/runtime/**` 暴露的领域 API，例如：

```js
runtime.files.read({ path })
runtime.files.write({ path, content, base_revision })
runtime.workspace.open({ path }) // 兼容 LocalFS
runtime.workspace.open({ location: { kind: "saf", uri, name } }) // Android SAF
runtime.git.status()
runtime.terminal.open({ cols, rows })
runtime.agent.start({...})
runtime.on("fs.changed", handler)
```

## 5. Rust Core 模块

### 5.1 Workspace / Files
必须保留旧实现的关键语义：

- 工作区沙箱，禁止 `..` / symlink 越界；
- SHA-256 Revision；
- `base_revision` 冲突检测；
- 原子写入；
- 创建 / 删除 / 重命名 / 复制；
- 事务式分块写入；
- 文件树 / 搜索；
- 用户和 Agent 修改都产出统一 Change Event；
- 被覆盖 / 删除内容可恢复。

### 5.2 Checkpoint / Trash

- 每个 Agent 任务有独立 checkpoint；
- 单步、单文件、整个任务可撤销；
- 删除和破坏性恢复优先进入 Diffusion Trash；
- Git 强制回退同样必须走安全恢复路径，而不是裸 `git reset --hard` 覆盖磁盘。

### 5.3 Security

- HardPolicy 是 Rust Core 内部不可绕过的底层规则；
- permission mode、tool rules、单次批准保留；
- UI 不能通过调用低级 IPC 绕过 Workspace / Policy。

### 5.4 Providers / Agent

- HTTP/SSE 由 Rust 直接发起；
- API Key 存储在 Native Core 数据目录，不回传明文；
- OpenAI-compatible / Anthropic / Gemini 至少保持旧版能力；
- Tool Call、Reasoning、ask_user、审批、停止、上下文历史继续通过 Runtime Event 暴露。

### 5.5 Git

领域 API 不假定系统一定存在 `git` 命令。

- 桌面第一阶段允许调用系统 Git；
- Android 必须可替换为嵌入式 Git backend；
- UI 不得知道使用的是哪种 backend。

### 5.6 Terminal

终端是平台能力，不是 Core 的绝对前提：

```text
TerminalBackend
├─ Desktop PTY backend
└─ Android backend
```

Android 第一阶段允许能力少于桌面，但“没有桌面 PTY”不能导致整个 App 无法运行。

## 6. Android

Android 必须是独立可用的本地 App，不是电脑遥控器。

- Rust Core 直接打入 APK；
- 项目目录通过 Android SAF / 持久 URI 权限访问；
- Workspace 使用抽象文件后端，不把 `PathBuf` 当作所有平台唯一真相；
- AI、会话、Checkpoint、代码修改均可在手机本机完成；
- “连接电脑/SSH”只作为可选运行环境。

## 7. 桌面

第一目标 Windows：

- Tauri 壳 + Rust Core；
- 无 Python sidecar；
- 无本地 HTTP/WebSocket 服务器；
- 打开 App 时 Core 已存在；
- 文件选择使用系统原生对话框；
- 正常退出时不留下额外 Bridge 进程。

## 8. 迁移阶段

### Phase A：断开 UI 与 Bridge 的直接耦合
- [x] 新建 `services/runtime/`；
- [x] 旧 Bridge 封装为 `BridgeRuntimeAdapter`；
- [x] UI 全部改用 Runtime API；
- [x] Web 回归测试继续通过。

### Phase B：建立 Rust/Tauri 骨架
- [x] 新建 `apps/native/src-tauri/`；
- [x] 建立 IPC command / event 边界；
- [x] Native Adapter 自动选择；
- [x] Native hello / app info 源码已实现；

### Phase C：Workspace 迁移
- [x] open/close；
- [x] read/tree/hash/search；
- [x] write/patch/create/delete/rename/copy；
- [x] revision conflict；
- [x] trash；
- [x] chunked write；
- [x] Diffusion 内部 mutation 文件事件；
- [ ] 外部磁盘 watcher 事件。

### Phase D：设置、权限、会话、Checkpoint

### Phase E：Providers + Agent

### Phase F：Git + Process + Terminal

### Phase G：删除 Python
完成条件：

- `bridge/` 删除；
- `pyproject.toml` 删除；
- README 不再要求 Python；
- Python 测试被 Rust 测试覆盖；
- Windows 原生构建通过；
- Android 原生构建通过。

## 9. IPC 规则

Native IPC 不复制旧 WebSocket 协议的连接语义，但可以保留稳定的领域方法名以降低迁移成本。

IPC 返回统一错误：

```json
{"code":"CONFLICT","message":"文件已被修改","data":{}}
```

事件继续使用稳定领域名称：

- `fs.changed`
- `fs.external`
- `workspace.opened`
- `workspace.closed`
- `agent.*`
- `approval.*`
- `terminal.*`
- `git.changed`

事件名属于 Diffusion Domain Contract，不属于 WebSocket Contract。

## 10. 数据目录

所有平台统一通过 PlatformDataDir 获取：

- settings
- provider profiles / secrets
- device data（仅启用远程访问时）
- global instructions

项目内数据继续放在 `.diffusion/`（若旧实现已有对应位置，迁移时保持兼容）。

## 11. 测试门槛

每个迁移模块必须同时有：

1. 旧行为回归测试；
2. Rust 单元测试；
3. UI Runtime mock 测试；
4. 涉及文件破坏性的操作必须额外覆盖越界、symlink、revision conflict、恢复路径。

不得为了“Rust 版能跑”删除安全测试。

## 12. 构建产物

完成到可构建阶段后应提供：

- Windows `.exe` / installer；
- Android `.apk`；
- 完整源代码 `.zip`；
- 构建说明；
- 迁移状态文档。

若执行环境缺少 Rust、Android SDK/NDK 或 Windows toolchain，不得伪造二进制；必须保留可继续构建的源码和明确列出阻塞项。

## 13. 本轮实现原则

本轮优先顺序：

1. 固化 SPEC；
2. 断开前端直接 Bridge 耦合；
3. 建立 Rust/Tauri Native Core 工程骨架；
4. 优先迁移 Workspace / Filesystem，因为它是 Diffusion 安全和 Agent 修改代码的地基；
5. 再迁移其他模块；
6. 只有 Rust 替代能力达到旧版语义后才删除对应 Python 实现。
