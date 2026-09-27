# Koide Native 能力审计

> 当前版本：`1.0.0-rc.2`（`dev/1.0.0`，候选版准备，尚未发布）。本文记录 Native 主链与 Bridge 兼容链的真实能力和明确限制。

## 总览

- Runtime API：73 个业务方法；Native dispatch 当前 73 / 73 有路由。
- Windows / Android 本地应用默认使用 Rust Native Core。
- Python Bridge 是可选 Web/LAN 兼容端，不是本地 Native 前置条件。
- 平台不支持的能力必须返回明确错误或 `capability=false`，不能伪装为空结果。

## Workspace / IDE

- [x] LocalFS workspace / recent / remove_recent
- [x] read / tree / search / glob / hash
- [x] write / patch / create / delete / rename / copy
- [x] large write transaction
- [x] revision / conflict / atomic write
- [x] Trash / Checkpoint / Time Machine
- [x] ZIP Export
- [x] LocalFS 外部文件变更监听
- [x] Android SAF backend
- [x] SAF recent / persisted permission
- [x] SAF read/write/patch/tree/search/glob/checkpoint/trash/export

## Agent / Permissions

- [x] chat / read / edit / agent
- [x] fs_read / fs_list / fs_search / fs_glob / fs_multi_read
- [x] fs_patch / fs_write / fs_create / fs_delete / fs_rename / fs_copy
- [x] ask_user / shell_run / terminal_read / web_fetch
- [x] restricted / manual / ai / autonomous
- [x] per-tool rules / approval_profile / AI reviewer
- [x] HardPolicy 始终优先
- [x] max_tool_calls / max_seconds / max_repair_attempts
- [x] zero-tool incomplete protection
- [x] Project Memory（`.koide/PROJECT_MEMORY.md`）进入 Agent 上下文
- [x] Tool Call `call_id` ↔ Checkpoint 精确关联（Native / Bridge）
- [x] read / edit / web_fetch / shell_run 验证节点语义对齐
- [x] Time Machine 验证失败 → 修改 → 同一命令再验证故事线
- [x] 编辑事件 after_blob 与 after_rev：Native / Bridge 保存历史修改后版本
- [x] LocalFS / SAF 共用历史版本核验；旧数据不匹配明确返回 HISTORY_UNAVAILABLE
- [x] checkpoint.diff 的 text_available 标记，避免把二进制/超限文本解释为空文件
- [x] Native Android 语义触觉：独立插件、系统设置、前台判断与节流（具体手感待真机验收）
- [x] `feedback.emit` 在 Windows / Bridge 明确返回不支持；不振动远端设备
- [x] Native 握手的 SAF capability 与已实现的 Android 后端一致，移除过期未实现说明

## Providers

- [x] Profiles CRUD / models / connection test
- [x] OpenAI-compatible Tool Call
- [x] Anthropic Tool Call
- [x] Gemini Native function call
- [x] Agent 文本与 reasoning 流事件
- [x] OpenAI-compatible streamed tool-call 聚合
- [x] Anthropic SSE 解析
- [x] Gemini `streamGenerateContent?alt=sse` 解析
- [~] **即时 hard-cancel**：读循环会检查停止标志，但同步 HTTP read 被服务端长时间阻塞时，停止可能延迟。

## Git / Terminal / Process

- [x] Git status/diff/stage/unstage/discard/reset/commit/branches/checkout/log/blame/pull/push/init
- [x] Windows PTY
- [x] Terminal 命令运行 / 取消 / history / ports
- [x] Android 一次性 shell
- [ ] Android interactive PTY
- [x] SAF capability 降级：Git=false、terminal_cwd=false

## Devices / Remote

- [x] Native DeviceStore 的 list / revoke
- [ ] Native LAN server / 一次性配对码
- [ ] Native Remote Runtime adapter

Native 模式下 `devices.pair_code` 明确返回 `LAN_OFF`。需要跨设备访问时，1.0 开发线继续提供 Python Bridge 的 `--lan` 模式。

## CI 基线

主工作流要求：

- Web + UI 回归通过；
- Bridge 兼容回归通过；
- Runtime parity 检查通过；
- Rust library tests 通过；
- Android ARM64 APK 构建并验签；
- Windows x64 构建通过。

这些平台限制会继续如实记录，但不再用“是否删除 Python Bridge”来定义 Koide 能否发布正式版。
