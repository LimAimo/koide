# Diffusion IDE 0.8.0-alpha.7 交接文档

更新时间：2026-09-26  
开发分支：`dev/native-complete-alpha7`  
稳定主分支：`main` 仍停留在 alpha.6；**不要在 alpha.7 最终门禁通过前合并 main。**

## 1. 当前目标

把 v0.7 的 Python Bridge 本地能力迁移到 Tauri 2 + Rust Native Core，最终实现：
- Windows 本地 Native IDE；
- Android 本地 Native IDE；
- 本地模式不依赖 Python、localhost Bridge、Termux 或电脑；
- Remote Runtime 是可选能力，不得成为本地模式依赖；
- Python Bridge 只在功能等价、测试与实机门禁全部通过后删除。

## 2. 当前真实完成度

Runtime API 共 72 个业务方法。当前 NativeCore 已有 **69 / 72** 真实 dispatch，并有 CI parity gate 防止以后漏接。

已经进入 Native 主链：
- Workspace / Files / Revision / Patch / transactional large write；
- Diffusion Trash；
- Checkpoint / Time Machine；
- Provider profiles / models / test / secrets 基础；
- Conversations / compact；
- chat / read / edit / agent 四种 Agent 模式；
- ask_user；
- fs_glob / fs_multi_read；
- shell_run / terminal_read / web_fetch；
- Agent limits / repair / web_search 参数；
- PermissionEngine：restricted/manual/ai/autonomous；
- per-tool deny/ask/session/always/ai_review；
- allow/deny wildcard rules；
- AI approval reviewer；
- Aimo Constitution / global instructions / AGENTS.md；
- Recent projects；
- Git 14 个 Runtime 动作；
- Windows PTY；
- Process cancel / terminal history / ports；
- ZIP Export；
- External filesystem watcher；
- OpenAI-compatible SSE streaming / reasoning delta / MiniMax think split / streamed tool-call aggregation；
- Device token hashing/revoke 的 Rust 存储基础；
- Native-only Rust test gate。

## 3. 已验证构建

已知稳定门禁：
- Alpha7 workflow Run #61：
  - Native-only Rust tests：success
  - Windows x64 EXE：success
  - Android ARM64 APK：success
  - APK signature verify：success
- Alpha7 workflow Run #66：
  - Runtime API / Native dispatch parity：success
  - Native-only tests / 双平台构建门禁保持通过

CI 文件：`.github/workflows/native-alpha7.yml`

## 4. 仍未完成的硬缺口

### A. Android SAF 原地 WorkspaceBackend —— 最高优先级
必须做真正的 Storage Access Framework，而不是把目录复制进 app 私有目录后冒充“原地编辑”。

需要：
1. 系统目录选择器返回 tree URI；
2. `takePersistableUriPermission`；
3. 持久化授权项目；
4. DocumentsContract / DocumentFile backend；
5. 原地 tree/list/read/write/create/delete/rename/copy；
6. hash / revision / base_revision conflict；
7. search / glob；
8. Checkpoint blob 与 SAF 文件联动；
9. Diffusion-managed recovery / Trash 语义；
10. Git / Terminal 对 content URI 的能力检测与明确降级；
11. UI 不再把“导入私有工作区”作为 Android 唯一打开方式。

### B. Android interactive PTY
当前 Android 支持一次性 `/system/bin/sh` 命令，但 interactive `terminal.open/input/resize/history` 仍明确返回 `NO_PTY`。

不要把一次性 shell 命令描述成完整终端。

### C. Rust Remote Runtime / Pairing
DeviceStore 只是基础，不等于 Remote Runtime。

仍需：
- Rust HTTP/WebSocket 或等价 Remote server；
- 6 位一次性配对码；
- token hash / expiry / revoke；
- `devices.pair_code / list / revoke` 最终语义；
- RemoteRuntime adapter；
- LAN Host/Origin/token 安全边界；
- 替代旧 Python Bridge remote path。

### D. Provider hard-cancel / 全协议流式最终等价
OpenAI-compatible SSE 已通过 Android/Windows CI，但：
- 服务端完全沉默时 blocking read 仍不能真正即时 hard-cancel；
- Anthropic SSE / thinking delta / cancel 需要最终核验；
- Gemini `streamGenerateContent?alt=sse` / thought delta / cancel 需要最终核验；
- 需要 compatibility smoke tests。

### E. 最终回归
删除 Python 前必须：
- Rust / Native integration tests 覆盖旧 Bridge 关键行为；
- Web/UI regression 全绿；
- Windows Native-only smoke；
- Android SAF Native-only smoke；
- 真实 Android 设备：打开 SAF 项目 → 编辑 → Agent → Checkpoint；
- 真实 Windows：打开项目 → Agent → Git → Terminal → Export；
- 最后代码搜索确保 Native 产品路径没有 Python/localhost Bridge 必需假设。

## 5. Python Bridge 删除规则

**现在禁止删除：**
- `bridge/`
- `pyproject.toml`
- Bridge tests
- BridgeRuntimeAdapter

只有 `docs/NATIVE_PARITY_AUDIT.md` 的最终硬门禁全部通过后才能删除。

特别注意：
- “Rust 文件存在”不等于功能完成；
- “RPC 名字存在”不等于行为等价；
- 固定空数组、固定 false、no-op 都算未完成；
- Android 私有 workspace import 不等于 SAF；
- DeviceStore 不等于 Remote server；
- 一次性 Android shell 不等于 interactive PTY。

## 6. 文档优先级

继续任务时按以下顺序看：
1. `docs/NATIVE_PARITY_AUDIT.md` —— **最高优先级，删除 Python 的硬门禁**
2. 本文件 `docs/HANDOFF_ALPHA7.md`
3. `docs/MIGRATION_STATUS.md`
4. `CHANGELOG.md`
5. `docs/NATIVE_CORE_SPEC.md`

如果文档互相冲突，以代码 + 最新 CI + `NATIVE_PARITY_AUDIT.md` 为准。

## 7. 推荐继续顺序

1. Android SAF WorkspaceBackend；
2. Android interactive PTY；
3. Provider hard-cancel + Anthropic/Gemini streaming parity；
4. Rust Remote Runtime / pairing；
5. Native integration + UI + 实机 smoke；
6. 再跑 Runtime 72/72 parity；
7. Android + Windows 全绿；
8. 最后才删除 Python；
9. 删除后再跑一次完整 Native-only 门禁；
10. 更新架构图、README、MIGRATION_STATUS，并决定是否合并 main / 创建 alpha prerelease。

## 8. 当前分支策略

- `main`：保持 alpha.6 稳定基线；
- `dev/native-complete-alpha7`：alpha.7 总集成；
- Provider 等实验分支只有在 CI 验证后才应合回 alpha7；
- 不要把半完成 SAF / Remote / PTY 直接推 main。

## 9. 打包规则

交接源码包必须来自 `dev/native-complete-alpha7` 的明确 commit，并包含：
- `SOURCE_SNAPSHOT.txt`（branch + commit）；
- 完整源码；
- docs；
- GitHub Actions；
- 不包含 `.git`、`node_modules`、`target`。

建议文件名：
`diffusion-ide-v0.8.0-alpha.7-handoff-<shortsha>.zip`

## 10. 一句话状态

**Diffusion IDE 已经从“Native 壳 + 文件核心”推进到“绝大多数本地 IDE 能力都在 Rust 主链中”，但 Android SAF、Android interactive PTY、Rust Remote Runtime 和 Provider hard-cancel/全协议流式等价仍是真正的最后硬骨头；Python Bridge 现在仍是行为基线，不能删。**
