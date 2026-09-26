# Native / Python Bridge 功能等价审计

> 分支：`dev/native-complete-alpha7`
>
> 规则：**本文件全部硬门槛完成前，不允许删除 `bridge/`、`pyproject.toml` 或 Bridge 测试。**
>
> 目标不是“Rust 有同名函数”，而是前端可见行为、安全语义、事件、返回结构和错误行为与现有产品需求等价。

## 当前结论（alpha.7）

- Runtime API：72 个业务方法。
- Python Bridge：72 / 72 均有 RPC 实现。
- Rust NativeCore：**72 / 72 dispatch 路由已覆盖**，`node scripts/check-native-parity.mjs` 当前通过。
- 但 dispatch 全覆盖不等于语义全完成：`devices.pair_code` 当前仍明确返回 `LAN_OFF`，因为 Rust Remote Runtime server 尚未实现；它不能算 Remote pairing 已迁完。
- 本地 IDE 主链已经包含 Workspace、Files、Trash、Checkpoint、Profiles、Conversations、4 种 Agent 模式、Permissions、Instructions、Git、Terminal、Ports、Export、External Watcher。
- Android SAF 原地 WorkspaceBackend 已进入源码：系统 picker、持久 URI、DocumentsContract I/O、revision/conflict、search/glob、Checkpoint/Trash、recent 与 Git/Terminal capability 降级均已接线；**当前还需要本提交 Android CI 与真实设备 smoke**。
- 仍会阻止“彻底删除 Python”的主要硬缺口：
  1. Provider 全协议流式 / reasoning / 即时 hard-cancel 尚未全部完成；
  2. Android interactive PTY 尚未完成；
  3. 旧 Bridge 的 LAN / Remote Runtime 尚无 Rust 替代；
  4. SAF 尚缺当前实现的 Android 编译与真实设备最终验证。
- 因此当前 **仍禁止删除 Python Bridge**。

## A. Runtime RPC 覆盖

### Dispatch 路由（72 / 72）
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
- [x] Devices：pair_code / list / revoke 均有 Native dispatch 路由

> 注意：`devices.pair_code` 的路由当前会明确返回 `LAN_OFF`，因为 Rust Remote Runtime server 尚不存在。这是**语义门禁未完成**，不是 dispatch 漏接。`devices.list/revoke` 使用 Rust DeviceStore。

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
- [~] Android SAF：持久 URI 授权 + 原地 WorkspaceBackend 已实现，等待当前提交 Android CI / 实机验证
- [~] SAF 下 read/write/patch/tree/search/checkpoint/trash 已接线，等待 Android 实机行为验证

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

> 当前状态：源码接线完成；由于当前执行环境没有 Rust / Android toolchain，本节先记为 `[~]`，待 `native-alpha7` CI 编译通过后可把“源码/构建”项转为 `[x]`。真实设备 smoke 仍属于 I 节最终门禁。

- [~] 系统目录选择器返回 SAF tree URI
- [~] `takePersistableUriPermission` + 完整读写授权检查
- [~] recent 持久化已授权项目（tree URI + display name）
- [~] 独立 Tauri Android plugin + `ContentResolver` / `DocumentsContract` backend
- [~] 原地 tree/list/read/write/create/delete/rename/copy
- [~] 原地 hash / revision / `base_revision` conflict detection
- [~] search / glob
- [~] 事务式 large write：chunk 先落 app-private staging，commit 后写回 SAF
- [~] Checkpoint blob 与 SAF 文件联动，包括 Agent 新建目录回滚
- [~] Diffusion-managed Trash：删除前 stage 到应用私有 recovery，restore 再写回 SAF
- [~] ZIP Export 从 SAF backend staging 后生成归档
- [~] 项目 `AGENTS.md` 从 Workspace backend 读取，Agent 不再依赖 `PathBuf`
- [~] Git 能力检测与明确降级：SAF capability=false，返回 `WORKSPACE_CAPABILITY`
- [~] Terminal cwd 能力检测与明确降级：SAF capability=false，不把 content URI 当 cwd
- [~] UI：Android 可“从手机选择项目文件夹”原地打开 SAF；旧“复制到 Diffusion 私有工作区”保留为兼容入口
- [~] DocumentsProvider 兼容：child lookup 不依赖 provider selection；写模式提供 `rwt` → `w` fallback，Rust 层失败时尽力恢复原内容/清理半成品

## I. 删除 Python 前的最终硬门禁

- [ ] Runtime 72 / 72 Native 覆盖，或剩余能力正式从产品 API/UI 移除
- [ ] 不存在固定空值 / no-op / 假实现
- [x] 4 种 Agent 模式都有 Native 实现
- [x] Permission UI 与 Native engine 接通
- [x] Git UI 与 Native backend 接通
- [x] Terminal Runtime 接通
- [x] Export / watcher / recent / instructions 已迁
- [~] Android SAF 原地项目源码已接线；仍需当前提交 Android CI + 真实设备 smoke
- [ ] Provider 全协议 streaming / cancel 可用
- [ ] Rust Remote Runtime 替代 Python LAN/Devices
- [ ] Bridge 行为测试迁为 Rust / Native integration tests
- [x] Web/UI regression 当前全绿（本次修改后 `bash tests/run-all.sh` 通过；Bridge 47、Node 43、界面集成全通过）
- [x] Android ARM64 CI 已成功构建并验证 APK 签名（仍需 SAF 功能完成后再做最终门禁）
- [x] Windows x64 CI 已成功构建
- [ ] Native-only smoke：完全不启动 Python，覆盖打开项目 → 编辑 → Agent → Checkpoint → Git → Terminal → Export
- [ ] Android Native-only smoke：SAF 打开项目 → 编辑 → Agent → Checkpoint
- [ ] 最后代码搜索：产品 Native 路径无 Python / localhost Bridge 必需假设
- [~] README / MIGRATION_STATUS / SAF / Runtime API 文档已随本次实现更新；最终删 Python 前还需再做一次架构收口

只有以上全部完成后：
1. 删除 `bridge/`
2. 删除 `pyproject.toml`
3. 迁移/删除 `tests/bridge`
4. 用 Rust Remote Runtime adapter 替代旧 BridgeRuntimeAdapter
5. 再跑一次 Android + Windows + UI + Native-only 全套门禁


## 当前剩余硬缺口（更新）

1. **Android SAF 最终验证**：原地 WorkspaceBackend 已进入源码；待当前提交 Android CI 编译和真实设备“选择目录 → 编辑 → Agent → Checkpoint/revert → 重启重新打开” smoke。
2. **Android interactive PTY**：一次性 `/system/bin/sh` 命令可运行，但 `terminal.open/input/resize/history` 在 Android 明确返回 `NO_PTY`。
3. **Remote Runtime LAN server**：DeviceStore 已迁 Rust；`devices.list/revoke` 已接，`devices.pair_code` 仅有明确 `LAN_OFF` 路由，LAN server / pairing 语义尚未实现。
4. **Provider hard-cancel**：SSE streaming 已通过既有 Windows/Android CI；服务端沉默时 blocking read 仍需 async hard-cancel，Anthropic/Gemini 全协议 parity 也需最终核验。
5. **Native-only Rust smoke gate**：既有基线已通过；本次 SAF 变更还需要重新跑当前分支 CI。


### 已验证构建基线
- Native Alpha7 workflow run #61：Native-only Rust tests = success；Windows x64 EXE = success；Android ARM64 APK = success；APK signature verify = success。
