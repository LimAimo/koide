# Koide Native 能力审计

> 当前版本：`0.11.0`。本文记录 Native 主链的真实能力和明确限制，不再作为预发布迁移交接清单。

## 总览

- Runtime API：84 个业务方法；Native dispatch 当前 84 / 84 有路由。
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
- [x] 项目工作台元数据与 LocalFS / SAF 源码指纹
- [x] 批量编辑完整预检、revision、HardPolicy 和可恢复任务
- [x] LocalFS 运行向导与同基线隔离方案
- [x] 独立预览会话、元素反馈与真实浏览器截图
- [x] JS / TS Worker 语言服务；手机工作台与创作房间

## Agent / Permissions

- [x] chat / read / edit / agent
- [x] fs_read / fs_list / fs_search / fs_glob / fs_multi_read
- [x] fs_patch / fs_write / fs_create / fs_delete / fs_rename / fs_copy
- [x] ask_user / shell_run / terminal_read / web_fetch
- [x] restricted / manual / ai / autonomous
- [x] per-tool rules / approval_profile / AI reviewer
- [x] HardPolicy 始终优先
- [x] max_tool_calls / max_seconds / max_repair_attempts
- [x] token / 费用预算、重复失败保护
- [x] zero-tool incomplete protection

## Providers

- [x] Profiles CRUD / models / connection test
- [x] OpenAI-compatible Tool Call
- [x] Anthropic Tool Call
- [x] Gemini Native function call
- [x] Agent 文本与 reasoning 流事件
- [x] OpenAI-compatible streamed tool-call 聚合
- [x] Anthropic SSE 解析
- [x] Gemini `streamGenerateContent?alt=sse` 解析
- [x] 结构化视觉附件与真实用量事件
- [x] 响应头 / SSE / AI 审批 / web_fetch 可取消异步网络等待
- [x] `agent.stop` 独立于普通 Core dispatch 锁

取消检查约每 80ms 进行；同步文件系统和平台调用仍在安全边界结束后返回。费用按用户配置单价估算，不包括独立审批模型。

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

Native 模式下 `devices.pair_code` 明确返回 `LAN_OFF`。需要跨设备访问时，0.10.0 继续提供 Python Bridge 的 `--lan` 模式。

## CI 基线

主工作流要求：

- Web + UI 回归通过；
- 桌面 / 手机真实浏览器回归通过；
- Bridge 兼容回归通过；
- Runtime parity 检查通过；
- Rust library tests 通过；
- Android ARM64 APK 构建并验签；
- Windows x64 构建通过。

这些平台限制会继续如实记录，但不再用“是否删除 Python Bridge”来定义 Koide 能否发布正式版。

本轮本机完成 Windows Core 测试、发行 EXE / 中文安装包与真实 WebView2 启动验证。Android 0.10.0 的 APK / 签名 / 真机结果尚未在本机执行，保留相应 CI 门禁。
