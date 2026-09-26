# Native / Python Bridge 功能等价审计

> 分支：`dev/native-complete-alpha7`
>
> 规则：**本文件全部硬门槛完成前，不允许删除 `bridge/`、`pyproject.toml` 或 Bridge 测试。**
>
> 目标不是“Rust 有同名函数”，而是前端可见行为、安全语义、事件、返回结构和错误行为与现有产品需求等价。

## 当前结论（alpha.7）

- Runtime API：72 个业务方法。
- Python Bridge：72 / 72 均有 RPC 实现。
- Rust NativeCore：**69 / 72** 已有真实 dispatch。
- 仅剩 3 个 Runtime RPC 未迁：`devices.pair_code / devices.list / devices.revoke`。
- 本地 IDE 主链已经包含 Workspace、Files、Trash、Checkpoint、Profiles、Conversations、4 种 Agent 模式、Permissions、Instructions、Git、Terminal、Ports、Export、External Watcher。
- 仍有三个会阻止“彻底删除 Python”的硬缺口：
  1. Provider 全协议流式 / reasoning / 即时取消尚未全部完成；
  2. Android SAF 原地工作区尚未完成；
  3. 旧 Bridge 的 LAN / Devices / Remote Runtime 尚无 Rust 替代。
- 因此当前 **仍禁止删除 Python Bridge**。

## A. Runtime RPC 覆盖

### 已迁（69 / 72）
- [x] Workspace：open / close / browse / remove_recent
- [x] Files：read / tree / search / hash / write / patch / create / delete / rename / copy
- [x] Large write：begin / chunk / commit / abort
- [x] Export：`fs.export`
- [x] Trash：list / restore / delete / empty
- [x] Checkpoint：tasks / task / diff / revert_event / revert_file / revert_task
- [x] Profiles：list / save / delete / test / models
- [x] Conversations：list / get / delete / compact
- [x] Permissions：set
- [x] Approval：respond
- [x] Agent：start / stop / answer
- [x] Instructions：constitution / get / set
- [x] Git：status / diff / stage / unstage / discard / reset / commit / branches / checkout / log / blame / pull / push / init
- [x] Terminal：run / kill / open / input / resize / close / list / history
- [x] Ports：list

### 未迁（3 / 72）
- [ ] `devices.pair_code`
- [ ] `devices.list`
- [ ] `devices.revoke`

> Native 设置页已经把 Remote 明确隔离为可选模块，因此这 3 项不是本机 IDE 的使用阻塞项；但如果最终删除 Python Bridge，就必须先提供 Rust Remote Runtime / 配对替代，或正式从产品中移除远程能力并迁移 API/UI。

## B. Workspace / IDE 基础能力

- [x] 最近项目持久化
- [x] 打开项目后更新 recent
- [x] remove_recent
- [x] `workspace.recent_changed`
- [x] ZIP 导出，Native 侧通过系统保存对话框落盘
- [x] 外部文件 watcher
- [x] `fs.external` 由真实磁盘变化触发
- [x] Git 真实 backend 接入，不再是固定 `is_repo:false`
- [x] Windows PTY
- [x] Terminal 命令运行 / 取消 / history
- [x] Ports 列表
- [ ] Android SAF：持久 URI 授权 + 原地 WorkspaceBackend
- [ ] SAF 下 read/write/patch/tree/search/checkpoint/trash 与普通路径后端行为一致

## C. Agent / Permissions

### 模式
- [x] chat
- [x] read
- [x] edit
- [x] agent

### 工具
- [x] `fs_read`
- [x] `fs_list`
- [x] `fs_search`
- [x] `fs_glob`
- [x] `fs_multi_read`
- [x] `fs_patch`
- [x] `fs_write`
- [x] `fs_create`
- [x] `fs_delete`
- [x] `fs_rename`
- [x] `fs_copy`
- [x] `ask_user`
- [x] `shell_run`
- [x] `terminal_read`
- [x] `web_fetch`

### Permission Engine
- [x] mode：`restricted / manual / ai / autonomous`
- [x] per-tool：`deny / ask / session / always / ai_review`
- [x] tool_rules：allow / deny wildcard
- [x] approval_profile 持久化
- [x] `permissions.changed`
- [x] AI reviewer
- [x] AI reviewer 失败安全回退到 ASK_USER
- [x] HardPolicy 优先于用户规则 / Autonomous / AI reviewer
- [x] 写文件前审批 + Checkpoint
- [x] ask_user

### Agent 运行语义
- [x] `limits.max_tool_calls`
- [x] `limits.max_seconds`
- [x] `limits.max_repair_attempts`
- [x] malformed tool-arguments repair 上限
- [x] `web_search` 参数进入 Agent
- [x] shell / network HardPolicy
- [ ] Provider 请求全部可即时取消（OpenAI-compatible 正在 `dev/native-provider-stream-alpha7` 验证）
- [ ] 全协议流式文本
- [ ] 全协议 reasoning 流式
- [ ] 全协议 tool-call 流式聚合

## D. Instructions / 行为上下文

- [x] Aimo Constitution 原生迁移
- [x] `instructions.constitution`
- [x] `instructions.get`
- [x] `instructions.set`
- [x] Global instructions 20,000 字写入上限
- [x] Agent 注入 Global instructions（最多 6,000 字）
- [x] Agent 注入项目 `AGENTS.md`（最多 8,000 字）
- [x] Native hello 返回真实 permissions / tools / recent / approval_profile

## E. Provider

### 通用
- [x] Profiles CRUD
- [x] Models 列表
- [x] Connection test
- [x] OpenAI-compatible tool calls
- [x] Anthropic tool calls
- [x] Gemini Native function calls
- [x] reasoning 开关基础映射
- [x] DeepSeek web_search 请求参数
- [x] API Key 不回传前端
- [x] Unix / Android `secrets.json` 写入时保护为 0600
- [ ] Windows 系统凭据库（可选加强项；当前使用应用私有数据目录）

### Streaming / Cancel
- [~] OpenAI-compatible SSE：已在 `dev/native-provider-stream-alpha7` 实现，等待 Android/Windows CI
- [~] OpenAI-compatible Stop：可在 send / chunk 等待阶段取消，等待 CI
- [~] OpenAI-compatible reasoning delta：已实现，等待 CI
- [~] MiniMax inline `<think>` stream 分离：已实现，等待 CI
- [~] OpenAI-compatible streamed tool-call 聚合：已实现，等待 CI
- [ ] Anthropic SSE + thinking delta + cancellable request
- [ ] Gemini Native `streamGenerateContent?alt=sse` + thought delta + cancellable request
- [ ] Provider 非流式 fallback / compatibility smoke tests

## F. Git / Terminal / Watcher / Export

- [x] Git 14 个 Runtime 动作真实接线
- [x] Git restore/reset 的受保护二进制写入
- [x] Windows PTY
- [x] Android Terminal 明确 backend / 降级路径
- [x] terminal.start / output / exit 兼容事件
- [x] terminal.data / closed 交互终端事件
- [x] Process cancel
- [x] Ports
- [x] ZIP Export
- [x] 外部文件 watcher + workspace 生命周期
- [~] 当前大整合分支 Android 已成功构建和验签；Windows 正在修最后的 PTY exit-code 类型问题并重新验证

## G. Remote Runtime / Devices

- [ ] Rust 本地 HTTP/WebSocket/IPC Remote Runtime server
- [ ] 6 位一次性配对码
- [ ] token hash 持久化
- [ ] token 过期 / revoke
- [ ] `devices.pair_code / list / revoke`
- [ ] RemoteRuntime adapter 不依赖 Python
- [ ] LAN 模式安全边界与旧 Bridge 等价
- [ ] 决定 BridgeRuntimeAdapter 的最终命运：由 Rust Remote adapter 替代后删除，或保留纯协议兼容层但不依赖 Python

## H. Android SAF

- [ ] 系统目录选择器返回 SAF tree URI
- [ ] `takePersistableUriPermission`
- [ ] 持久化已授权项目
- [ ] DocumentFile / DocumentsContract backend
- [ ] 原地 tree/list/read/write/create/delete/rename/copy
- [ ] 原地 hash / revision / conflict detection
- [ ] search / glob
- [ ] Checkpoint blob 与 SAF 文件联动
- [ ] Trash 语义定义（SAF 无原生 trash 时使用 Diffusion-managed recovery）
- [ ] Git 能力检测与明确降级（普通 content URI 不保证系统 Git 可直接访问）
- [ ] Terminal cwd 能力检测与明确降级
- [ ] UI 不再把“导入私有工作区”作为唯一 Android 打开项目方式

## I. 删除 Python 前的最终硬门禁

- [ ] Runtime 72 / 72 Native 覆盖，或剩余能力正式从产品 API/UI 移除
- [ ] 不存在固定空值 / no-op / 假实现
- [x] 4 种 Agent 模式都有 Native 实现
- [x] Permission UI 与 Native engine 接通
- [x] Git UI 与 Native backend 接通
- [x] Terminal Runtime 接通
- [x] Export / watcher / recent / instructions 已迁
- [ ] Android SAF 原地项目可用
- [ ] Provider 全协议 streaming / cancel 可用
- [ ] Rust Remote Runtime 替代 Python LAN/Devices
- [ ] Bridge 行为测试迁为 Rust / Native integration tests
- [ ] Web/UI regression 全绿
- [ ] Android ARM64 CI 全绿 + APK 签名通过
- [ ] Windows x64 CI 全绿
- [ ] Native-only smoke：完全不启动 Python，覆盖打开项目 → 编辑 → Agent → Checkpoint → Git → Terminal → Export
- [ ] Android Native-only smoke：SAF 打开项目 → 编辑 → Agent → Checkpoint
- [ ] 最后代码搜索：产品 Native 路径无 Python / localhost Bridge 必需假设
- [ ] README / MIGRATION_STATUS / 架构图更新完成

只有以上全部完成后：
1. 删除 `bridge/`
2. 删除 `pyproject.toml`
3. 迁移/删除 `tests/bridge`
4. 用 Rust Remote Runtime adapter 替代旧 BridgeRuntimeAdapter
5. 再跑一次 Android + Windows + UI + Native-only 全套门禁


## 当前剩余硬缺口（更新）

1. **Android SAF 原地 WorkspaceBackend**：尚未完成。当前 Android 私有 workspace 不能冒充 SAF。
2. **Android interactive PTY**：一次性 `/system/bin/sh` 命令可运行，但 `terminal.open/input/resize/history` 在 Android 明确返回 `NO_PTY`。
3. **Remote Runtime LAN server**：DeviceStore 已迁 Rust；LAN server 尚未接，因此 3 个 devices RPC 暂不伪实现。
4. **最新 Provider streaming 提交的全平台 CI**：等待 Native Alpha7 workflow 验证。
5. **Native-only Rust smoke gate**：已加入 CI，等待首次结果。
