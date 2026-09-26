# Native Core 迁移状态

## 0.8.0-alpha.7 开发检查点

> Python Bridge **尚未删除，也不允许提前删除**。完整等价门禁见 `docs/NATIVE_PARITY_AUDIT.md`。

### 已完成 / 已有稳定基础

- [x] UI 通过统一 Runtime API 与 Bridge 协议解耦；
- [x] Tauri 2 + Rust NativeCore；
- [x] Workspace：open / close / browse；
- [x] Files：read / hash / tree / search / write / patch / create / delete / rename / copy；
- [x] SHA-256 Revision、base_revision 冲突检测、原子写入、symlink 越界防护；
- [x] Diffusion Trash；
- [x] Checkpoint / Time Machine 基础：blob、task、event、diff、revert file/task/event；
- [x] 事务式大文件写入；
- [x] Provider Profiles / models / test / secrets 基础；
- [x] Conversations + compact；
- [x] Native chat / read Agent；
- [x] Native edit Agent 基础：HardPolicy → approval → Checkpoint → mutation；
- [x] ask_user；
- [x] Git Rust backend 主体并已接入 NativeCore；
- [x] recent / permissions / approval_profile 持久化基础；
- [x] Aimo 宪法、global instructions、项目 AGENTS.md 注入 Native Agent；
- [x] Android ARM64 与 Windows x64 GitHub Actions 构建链；
- [x] Android APK 签名验证；
- [x] Android + Windows 双平台成功后自动创建 prerelease；
- [x] alpha.6 Build #33 已真实产出 APK、portable EXE 与 NSIS installer。

### alpha.7 当前状态

- [x] PermissionEngine：restricted/manual/ai/autonomous + per-tool + rules + AI reviewer；
- [x] fs_glob / fs_multi_read；
- [x] 完整 agent 模式：shell_run / terminal_read / web_fetch；
- [x] limits / repair / web_search / zero-tool incomplete protection；
- [~] Provider streaming / reasoning delta / 可取消请求：OpenAI-compatible 已推进，Anthropic/Gemini 与沉默连接 hard-cancel 仍需收口；
- [x] Terminal / Process / Ports（Windows PTY；Android interactive PTY 仍是单独硬缺口）；
- [x] fs.export；
- [x] 外部磁盘 watcher（LocalFS）；
- [~] Android SAF 原地 WorkspaceBackend：源码实现完成，等待当前提交 Android CI / 真实设备 smoke；
- [ ] Android interactive PTY；
- [ ] Rust Remote Runtime / pairing（可选，不得成为本地模式依赖）；
- [~] secrets 平台安全加固：Unix / Android 0600 已有，Windows credential store 属可选加强；
- [x] Native-only 行为测试与 Web/UI 回归已有通过基线；本次 SAF 变更需 CI 重新验证 Rust/Android。

### Python 删除硬门禁

当前 Runtime API 共 72 个业务方法：
- Python Bridge：72 / 72 有 RPC 实现；
- NativeCore：72 / 72 dispatch 路由已覆盖，parity gate 当前通过；
- 但 `devices.pair_code` 等仍存在明确的语义缺口，dispatch 全覆盖不能替代功能等价审计；
- 详细逐项状态以 `docs/NATIVE_PARITY_AUDIT.md` 为准。

只有该审计文件 I 节最终硬门禁全部通过，才允许：
1. 删除 `bridge/`；
2. 删除 `pyproject.toml`；
3. 迁移/删除 Bridge tests；
4. 清理 BridgeRuntimeAdapter；
5. 更新最终 Native-only 架构文档。

## 当前构建状态

### Android
- GitHub Actions 已可从源码构建 ARM64 Tauri APK；
- APK 会在 Release 前执行 `apksigner verify`；
- alpha.6 Build #33 已成功；
- 当前最终产品缺口不是“能否生成 APK”；SAF 源码已接线但需要当前提交重新编译与实机验证，Android interactive Terminal / Remote Runtime / Provider 最终 parity 仍未完成。

### Windows
- GitHub Actions 已可构建 Windows x64 portable EXE 与 NSIS installer；
- alpha.6 Build #33 已成功；
- 当前最终产品缺口不是 `llvm-rc`，而是完整 Native 功能等价和终端/Agent 能力。

## 当前原则

1. 不因为“Rust 文件存在”就把功能标记为完成；必须真正接入 Runtime dispatch 和 UI。
2. 不因为“RPC 同名”就认为等价；返回结构、事件、错误、安全和持久化语义也必须对齐。
3. 每个大阶段必须经过 Android + Windows CI。
4. Python Bridge 保留为迁移期行为基线，直到 Native-only 门禁全部通过。
5. 修完所有已知迁移缺口之前，版本保持 alpha。
