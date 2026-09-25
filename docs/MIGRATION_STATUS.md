# Native Core 迁移状态

## 0.8.0-alpha.3 检查点

### 已完成

- [x] 统一 Runtime API；产品 UI 不再直接依赖 `bridge.rpc(...)` / `Bridge.pair(...)`；
- [x] BridgeRuntimeAdapter 仅保留迁移期兼容；NativeRuntimeAdapter 通过 Tauri IPC / Event 直连 Rust；
- [x] Tauri 2 原生工程骨架；
- [x] Rust NativeCore dispatch；
- [x] Rust Workspace：open / close / browse；
- [x] Rust Files：read / hash / tree / search / write / patch / create / delete / rename / copy；
- [x] SHA-256 Revision、base_revision 冲突检测、原子写入；
- [x] symlink 越界检查；
- [x] Diffusion Trash：删除、列表、恢复、永久删除、清空；
- [x] CheckpointStore：blob、任务、事件、diff、revert file/task/event；
- [x] 大文件事务写入：begin / chunk / commit / abort，校验字节数和 SHA-256；
- [x] Native Runtime 领域事件；
- [x] Rust 直接依赖面收缩：不再直接依赖 `hex` / `sha2` / `uuid` / `walkdir` / `windows-sys`；
- [x] Cargo vendor + `Cargo.lock` 已验证可完整离线解析；
- [x] **Android ARM64 `cargo check --offline --locked` 真实通过**；
- [x] Tauri Android 工程成功生成；
- [x] ARM64 `libdiffusion_native_lib.so` 真实构建成功；
- [x] Windows 标准多尺寸 `icon.ico` 已生成；
- [x] 旧前端 / Bridge 行为回归保持 113/113 通过。

### Phase C 尚未完成

- [ ] `fs.export`；
- [ ] 外部文件 watcher（磁盘在 Diffusion 之外变化时的 `fs.external`）；
- [ ] Android SAF WorkspaceBackend；
- [ ] Agent 真正接管 Rust Workspace 后，将 first-touch / edit 自动写入 Rust CheckpointStore。

### 后续阶段

- [ ] Settings / Provider Profiles / Secrets；
- [ ] Permissions / HardPolicy；
- [ ] Conversations；
- [ ] OpenAI-compatible / Anthropic / Gemini Provider；
- [ ] Agent Runtime / Tool Registry / ask_user / approvals；
- [ ] Git；
- [ ] Process / PTY Terminal；
- [ ] Android SAF + Android Terminal backend；
- [ ] Remote Runtime（可选跨设备功能）；
- [ ] 删除 `bridge/` 与 `pyproject.toml`。

## 当前构建边界

### Android

Rust/Tauri native 层已经可以编译。`tauri android build --debug --target aarch64 --apk` 已经完成 Rust 编译、生成并链接 `libdiffusion_native_lib.so`，随后在 Gradle Wrapper 阶段停止：当前隔离环境无法访问 `services.gradle.org` 下载 `gradle-8.14.3-bin.zip`。

Gradle distribution 到位后，还需要实际解析 Android Gradle Plugin 8.11.0、Kotlin Gradle Plugin 1.9.25 与 AndroidX/Material 等 Maven 依赖；这些尚未声称已缓存。

### Windows

`x86_64-pc-windows-msvc` 目标可以离线解析到本项目 `build.rs`。补齐 `icons/icon.ico` 后，下一阻塞是宿主机缺少 `llvm-rc`。这说明目前不是 Rust Core 平台代码错误，而是 Windows Resource 交叉编译工具缺口。

## 下一检查点建议

1. 补 Gradle 8.14.3 distribution，并让 Gradle 报出真实 Maven 缺口；
2. 准备 Android Gradle/Maven 离线缓存，产出第一份 ARM64 debug APK；
3. 补 `llvm-rc`，继续 Windows MSVC / cargo-xwin 构建验证；
4. 构建链稳定后进入 HardPolicy / Permissions；
5. Settings / Provider Profiles / Secrets；
6. Conversations；
7. Providers；
8. Agent + Rust Checkpoint 自动记录；
9. Git；
10. Terminal / Android SAF / Remote Runtime；
11. Python 删除线。

## 本轮验证

- Python Bridge：47 / 47；
- Web / Editor / Runtime：43 / 43；
- UI Integration：23 / 23；
- 合计：113 / 113；
- Android ARM64 `cargo check --offline --locked`：通过；
- Tauri Android `init --skip-targets-install`：通过；
- ARM64 native `.so`：构建成功；
- Android APK：未完成，停在 Gradle 8.14.3 distribution 下载；
- Windows MSVC `cargo check`：进入 Tauri Windows resource 阶段，停在 `llvm-rc` 缺失。
