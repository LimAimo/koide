# Android SAF WorkspaceBackend

状态：**已进入 Koide 0.9.0 Native 主线，并通过 Android CI 编译与 APK 签名验证。** SAF 允许 Android 原地打开用户授权目录，而不是强制复制到应用私有目录后编辑。

## 原则

- SAF 不是 POSIX path；不把 `content://` URI 伪装成 `PathBuf`。
- 使用 `takePersistableUriPermission` 持久化授权。
- 文件访问通过 Android `ContentResolver` / `DocumentsContract`。
- Rust Core 负责 revision、checkpoint、trash、permission 与 Agent；Kotlin plugin 只提供 SAF I/O 原语。
- LocalFS 行为不能因为 SAF 支持而回归。

## Backend contract

`WorkspaceBackend` 覆盖：

- identity / display_name
- read / stat / list
- create_file / create_dir
- write_atomic
- delete / rename / copy
- exists

LocalFS 使用安全 canonicalization；SAF 使用 document-id tree traversal，并拒绝 `..`、绝对路径与 URI 注入。

## 已支持能力

- read / hash / tree / search / glob
- write / patch / create / delete / rename / copy
- begin_write / write_chunk / commit / abort
- Koide Trash
- Checkpoint / Time Machine
- Agent read / edit
- recent（tree URI + display name）
- ZIP Export
- 项目 `AGENTS.md`

## 明确限制

- **Git**：SAF 目录不是普通 cwd，因此 capability=false。
- **Terminal cwd**：Android shell 不能把 SAF URI 当 cwd，因此 capability=false。
- **外部变化**：不同 DocumentsProvider 的通知能力不一致，后端需要以 Provider 能力为准。

这些限制通过 workspace `capabilities` 暴露给 UI；调用不支持能力会返回 `WORKSPACE_CAPABILITY`，而不是伪造空结果。

## Android plugin

`apps/native/src-tauri/plugins/saf/` 是不会被 `tauri android init` 覆盖的独立 Tauri plugin。picker 流程：

1. `ACTION_OPEN_DOCUMENT_TREE`
2. READ / WRITE / PERSISTABLE URI flags
3. `takePersistableUriPermission`
4. 返回 tree URI + display name

## Workspace representation

Local：

```json
{"kind":"local","path":"C:/project"}
```

Android SAF：

```json
{"kind":"saf","uri":"content://...","name":"project"}
```

## Checkpoint / Trash

Checkpoint blob 存在应用私有 data dir。SAF 删除前先把可恢复内容 stage 到 Koide 管理的 Trash，再删除 document；restore 通过 backend 重新创建并写回。

## 持续验证

Android CI 能验证 Rust/Kotlin 编译、APK 组装和签名，但不能覆盖所有厂商 DocumentsProvider。发布后仍应在真实设备持续回归：选择目录 → 编辑 → Agent → Checkpoint/revert → 重启后从 recent 重新打开。
