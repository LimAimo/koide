# Native / Python Bridge 功能等价审计

> 分支：`dev/native-complete-alpha7`
>
> 规则：**本文件全部硬门槛完成前，不允许删除 `bridge/`、`pyproject.toml` 或 Bridge 测试。**
>
> 目标不是“Rust 有同名函数”，而是前端可见行为、安全语义、事件、返回结构和错误行为与现有产品需求等价。

## 当前结论

- Runtime API：72 个业务方法。
- Python Bridge：72 / 72 均有 RPC 实现。
- Rust NativeCore：42 / 72 有 dispatch 分支。
- 仍缺 30 个 Native RPC。
- 另外存在若干“有分支但仍是占位 / 语义缩水”的功能。
- 因此当前 **禁止删除 Python Bridge**。

## A. Native RPC 缺口（30）

### 文件 / 导出
- [ ] `fs.export`

### Git
> `core/git.rs` 已有多数实现，但尚未接入 NativeCore dispatch；当前 `git.status` 仍是固定 `is_repo:false` 占位。
- [ ] `git.status` 改为真实实现
- [ ] `git.diff`
- [ ] `git.stage`
- [ ] `git.unstage`
- [ ] `git.discard`
- [ ] `git.reset`
- [ ] `git.commit`
- [ ] `git.branches`
- [ ] `git.checkout`
- [ ] `git.log`
- [ ] `git.blame`
- [ ] `git.pull`
- [ ] `git.push`
- [ ] `git.init`

### Instructions
- [ ] `instructions.constitution`
- [ ] `instructions.get`
- [ ] `instructions.set`
- [ ] 全局指令上限与 Bridge 一致（20,000 字）
- [ ] 项目 `AGENTS.md` 读取行为与 Bridge 一致（最多 8,000 字）

### Permissions
- [ ] `permissions.set`
- [ ] mode：`restricted / manual / ai / autonomous`
- [ ] per-tool：`deny / ask / session / always / ai_review`
- [ ] tool_rules：allow / deny glob
- [ ] `approval_profile` 持久化
- [ ] `permissions.changed` 事件
- [ ] AI 审批模型
- [ ] HardPolicy 永远优先于用户规则 / Autonomous / AI reviewer

### Process / Terminal / Ports
- [ ] `terminal.run`
- [ ] `terminal.kill`
- [ ] `terminal.open`
- [ ] `terminal.input`
- [ ] `terminal.resize`
- [ ] `terminal.close`
- [ ] `terminal.list`
- [ ] `terminal.history`
- [ ] `ports.list`
- [ ] Windows PTY
- [ ] Android Terminal backend / 明确降级策略
- [ ] 命令进程树可取消
- [ ] `terminal.start/output/exit` 与 `terminal.data/closed` 事件兼容

### Devices / Remote
- [ ] `devices.pair_code`
- [ ] `devices.list`
- [ ] `devices.revoke`
- [ ] Native Remote Runtime 方案确定：实现或从本机模式 UI 明确隔离
- [ ] LAN/token/撤销/过期语义不能因删除 Bridge 丢失

## B. 已有 dispatch 但仍不等价

### Workspace / 最近项目
- [ ] `workspace.remove_recent` 目前是 no-op
- [ ] Native `hello.recent` 目前固定 `[]`
- [ ] 打开项目后写入 recent
- [ ] 移除 recent 后发 `workspace.recent_changed`
- [ ] recent 持久化

### hello / 能力描述
- [ ] Native permissions mode 名称修正：当前误写 `strict`，Bridge/UI 使用 `restricted`
- [ ] `tool_settings_options` 不能是空数组
- [ ] `tools` 不能是空数组
- [ ] `approval_profile`
- [ ] permissions 当前真实配置
- [ ] recent 当前真实配置
- [ ] agent_modes 与实际能力一致

### Git
- [ ] 当前 `git.status` 固定返回 `is_repo:false`，必须移除占位

## C. Agent 能力差异

### 模式
- [x] chat
- [x] read
- [x] edit
- [ ] agent（完整：read + write + delete + exec + network + interaction）

### Bridge 有、Native 尚缺的工具
- [ ] `fs_glob`
- [ ] `fs_multi_read`
- [ ] `shell_run`
- [ ] `terminal_read`
- [ ] `web_fetch`
- [x] `ask_user`
- [x] guarded write tools

### Agent 运行语义
- [ ] `limits.max_tool_calls`
- [ ] `limits.max_seconds`
- [ ] `limits.max_repair_attempts`
- [ ] malformed tool-arguments repair
- [ ] `web_search` 参数
- [ ] 非 chat 模式“零工具调用即疑似未完成”的保护
- [ ] tool result 截断 / 上限与 Bridge 行为对齐

### 停止 / 流式
- [ ] Provider 请求改为可取消
- [ ] Stop 可中断正在进行的网络请求，而不是只在工具轮之间检查
- [ ] 文本流式增量
- [ ] reasoning 流式增量（`agent.reasoning`）
- [ ] tool-call 增量 / 完成语义
- [ ] SSE / chunked provider 解析

## D. Provider 行为差异

### OpenAI-compatible
- [ ] 流式 SSE
- [ ] reasoning_content / reasoning 分流
- [ ] MiniMax inline `<think>` 分离兼容
- [ ] DeepSeek built-in `web_search`
- [ ] timeout 不应固定为 30 秒

### Anthropic
- [ ] 流式 SSE
- [ ] thinking delta
- [ ] 旧模型 manual extended thinking / budget 兼容
- [ ] sampling：temperature / top_p

### Gemini Native
- [ ] `streamGenerateContent?alt=sse`
- [ ] generationConfig sampling 映射
- [ ] thinkingConfig 按模型代际处理
- [ ] thought 与普通文本分流

### Secrets
- [ ] Native `secrets.json` 权限保护达到 Bridge 的 0600 等价目标（POSIX）
- [ ] Windows 应使用应用私有目录并补安全说明 / 可行时使用平台凭据存储

## E. 文件系统 / IDE 体验

- [ ] `fs.export`：zip，跳过可再生成目录，300 MB 上限
- [ ] 外部文件 watcher
- [ ] `fs.external` 真正由磁盘变化触发，而不只是内部 copy 触发
- [ ] watcher 上限 / 排除目录与 Bridge 等价
- [ ] Android SAF：持久目录授权 + 原地 WorkspaceBackend
- [ ] Android 不再只能“导入私有工作区后编辑”
- [ ] SAF 下 read/write/patch/tree/search/checkpoint/trash 行为一致

## F. 测试 / 删除门禁

删除 Python Bridge 前必须同时满足：

- [ ] Runtime 72 / 72 Native dispatch 全覆盖，或明确从产品 API 中正式移除并迁移 UI
- [ ] 不存在占位实现（固定空值 / no-op）
- [ ] 4 种 Agent 模式都可用
- [ ] Permission UI 完整可用
- [ ] Git UI 完整可用
- [ ] Terminal UI 在 Windows 可用，Android 有正式 backend 或产品定义的明确能力
- [ ] Export / watcher / recent / instructions 可用
- [ ] Android SAF 原地项目可用
- [ ] Provider streaming / cancel 可用
- [ ] Bridge 现有行为测试已迁到 Rust / Native integration tests
- [ ] Web/UI regression 全绿
- [ ] Android ARM64 CI 全绿 + APK 签名通过
- [ ] Windows x64 CI 全绿
- [ ] 至少一次 Native-only smoke test：运行时完全不启动 Python 仍能覆盖核心产品流程
- [ ] 最后一次代码搜索：产品路径无 `Bridge.pair` / Python 必需文案 / localhost bridge 假设

只有以上全部完成后：
1. 删除 `bridge/`
2. 删除 `pyproject.toml`
3. 删除/迁移 `tests/bridge`
4. 删除 BridgeRuntimeAdapter（若 Remote Runtime 已有独立实现）
5. 更新 README / MIGRATION_STATUS / 架构图
