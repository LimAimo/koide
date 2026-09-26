# Android SAF WorkspaceBackend 设计

状态：实现前设计门禁。目标是让 Android 能**原地**打开用户通过 Storage Access Framework 授权的目录，而不是复制到 Diffusion 私有目录后编辑。

## 原则

- LocalFs workspace 现有行为不得回归。
- SAF 不是 POSIX path；绝不把 `content://` URI 伪装成 `PathBuf`。
- SAF 权限使用 `takePersistableUriPermission` 持久化。
- 文件访问通过 Android `ContentResolver` / `DocumentsContract`。
- Rust Core 仍拥有业务语义：revision、checkpoint、trash、permission、Agent。
- Android/Kotlin 层只负责 SAF I/O 原语，不承载 Agent/业务规则。

## Backend contract

`WorkspaceBackend` 需要支持：

- identity() -> stable workspace id
- display_name()
- read(rel)
- stat(rel)
- list(rel)
- create_file(rel)
- create_dir(rel)
- write_atomic(rel, bytes)
- delete(rel)
- rename(from,to)
- copy(from,to)
- exists(rel)

LocalFs 继续使用当前安全 canonicalization；AndroidSaf 使用 document-id tree traversal，拒绝 `..`、绝对路径和 URI 注入。

## SAF 与现有能力的关系

### 必须原地可用
- read/hash/tree/search
- write/patch/create/delete/rename/copy
- begin_write/write_chunk/commit/abort
- Diffusion Trash
- Checkpoint / Time Machine
- Agent read/edit

### 能力受限
- Git：SAF 目录不是普通 cwd。第一阶段 capability=false，不允许假装 git 可用；后续可实现 mirror/staging backend，但必须显式同步。
- external watcher：使用 ContentObserver / 周期快照，不使用 PathBuf watcher。
- Terminal cwd：Android shell 无法把 SAF URI 当 cwd；命令工具只对 LocalFs workspace 开放，或显式 materialize 到临时目录。
- Export：直接从 backend 遍历写 zip。
- Recent：保存稳定 tree URI + display name，不保存伪路径。

## Android plugin

建立稳定、不会被 `tauri android init` 覆盖的 Android plugin/source：

- pickTree()
- list(uri, rel)
- read(uri, rel)
- write(uri, rel, bytes)
- create(uri, rel, kind)
- delete(uri, rel)
- rename(uri, from, to)
- copy(uri, from, to)
- stat(uri, rel)

pickTree 必须：
1. ACTION_OPEN_DOCUMENT_TREE
2. FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION
3. FLAG_GRANT_PERSISTABLE_URI_PERMISSION
4. takePersistableUriPermission
5. 返回 tree URI + display name

## Workspace representation

Local:
```json
{"kind":"local","path":"C:/project"}
```

Android SAF:
```json
{"kind":"saf","uri":"content://...","name":"project"}
```

Runtime API 后续允许 `workspace.open` 接受结构化 location；为兼容现有 UI，string path 继续代表 LocalFs。

## Checkpoint / Trash

Checkpoint blobs 本身仍存 Diffusion 私有 data_dir，安全且高效。

Trash 对 SAF 不依赖系统回收站：
- delete 前把原内容/元数据记录到 Checkpoint/Trash store
- 再删除 SAF document
- restore 通过 backend recreate/write

## 完成标准

- Android 选择任意 SAF tree 后无需复制即可打开。
- 退出/重启 App 后仍可访问授权目录。
- 编辑原文件后外部文件管理器可立即看到变化。
- Agent edit/checkpoint/revert 对 SAF 生效。
- LocalFs Windows/Android 私有 workspace 回归测试全绿。
- Git/Terminal 对 SAF workspace 显示明确 capability，不报误导性“空仓库/空终端”。
