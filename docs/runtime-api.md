# Runtime API

Runtime API 是 Koide UI 与执行环境之间唯一允许的边界。

```js
import { runtime } from "./services/runtime/index.js";

await runtime.files.read({ path: "src/main.js" });
await runtime.git.status();
runtime.on("fs.changed", handler);
```

当前适配器：

- `NativeRuntimeAdapter`：Tauri IPC → Rust Native Core，Windows / Android 本地应用的主路径；
- `BridgeRuntimeAdapter`：WebSocket → Python Bridge，用于浏览器 / LAN 兼容模式。

产品组件不允许直接 import `services/bridge.js`。未来若实现 Rust Remote Runtime，应新增独立 Remote adapter，而不是让本地 Native 路径重新依赖 localhost/WebSocket。

## Workspace location

`workspace.open` 接受旧式 local path，也接受结构化 `location`：

```js
await runtime.workspace.open({ location: { kind: "local", path: "C:/project" } });
await runtime.workspace.open({ location: { kind: "saf", uri: "content://...", name: "project" } });
```

Android 需要系统选择目录时可发送：

```js
await runtime.workspace.open({ location: { kind: "saf", pick: true } });
```

Native Core 会调用 SAF picker，并把最终 `{kind, uri, name}` 写入 recent。SAF URI 不是 POSIX path，UI 与 Core 都不能把它拼成 `PathBuf`。

`workspace.opened` 返回的 workspace 信息包含 `backend`、`location` 与 `capabilities`。SAF 当前 `git=false`、`terminal_cwd=false`；调用依赖普通 cwd 的 Git/Terminal API 会返回 `WORKSPACE_CAPABILITY`。

## Native 语义

当前 Runtime 共 73 个业务方法，Native dispatch 全部有明确路由。存在平台不支持的能力时必须返回明确错误或 capability=false，不能使用固定空值假装成功。

## 语义反馈

`hello.capabilities.haptics` 表示当前客户端是否有原生触觉通路：Android Native 为 true，Windows 与 Bridge 为 false，不代表系统一定允许每次振动。

`runtime.feedback.emit({ kind })` 调用 `feedback.emit`，只接受 `snap`、`confirm`、`complete`、`restore`。返回 `{ supported, performed, reason }`；Windows / Bridge 返回 `{ supported:false, performed:false, reason:"unsupported" }`，非法类型返回 `BAD_REQUEST`。Android 的 `reason` 可为 `performed`、`background`、`expired`、`throttled`、`system_or_device`，原生插件不可用映射为 `FEEDBACK_UNAVAILABLE`。

反馈不是 Agent 工具，不写入工程时间线，也不构造 Checkpoint。提示音在当前客户端本地合成，不发送给 Bridge；设置、触发与降级语义见 [FEEDBACK.md](FEEDBACK.md)。


## Koide 1.0 Checkpoint 事件元数据

1.0 新产生的 Agent checkpoint 事件可携带 `call_id`、`tool` 与 `arguments`，用于把 Time Machine 节点精确关联到实际 Tool Call。旧任务可能没有这些字段，UI 必须保持向后兼容。

- `read`：读取、目录/搜索/Glob、批量读取和 `web_fetch` 等真实探索动作。
- `edit`：文件创建、修改、删除、重命名或复制；包含路径、before blob / after revision 等恢复信息，并在 Agent 调用时携带 `call_id`。
- `build_failed` / `build_ok`：`shell_run` 验证结果，包含退出码、末尾输出以及调用关联。
- `task_started` / `task_complete` / `task_status`：任务生命周期。

`call_id` 只用于关联真实运行事件，不代表模型推理步骤；Time Machine 不应根据缺失事件虚构探索、修改或验证。

## 1.0 历史 Diff 快照

`checkpoint.diff({ task_id, seq })` 返回 `{ path, before, after, text_available }`。`before` / `after` 为 UTF-8 文本或 `null`；仅凭 `null` 不能判断空文件/删除，`text_available=false` 表示存在二进制或超过文本预览限制的内容。空文件文本为 `""`。

新编辑事件保存 `after_blob`（删除时明确为 `null`），与 `after_rev` 一起固定修改后的版本。Native LocalFS 和 Android SAF 共用解析逻辑。回滚只修改撤销标记和工作区，不覆盖这些历史快照。

兼容旧任务时，优先核对后续同路径编辑的 before blob，再核对当前文件；只有 revision 与该事件 `after_rev` 一致才可展示。删除事件的 `after_rev="absent"` 表示当时不存在，不读取后来重建的文件。无法找到匹配版本返回 `HISTORY_UNAVAILABLE`，不能把当前文件伪装成历史版本。

UI 的文件统计是逐步修改量之和，包含已撤销事件，不表示整任务的净 Git Diff；行比较具有计算预算，超限、非文本或不可用事件不显示猜测的增删数。Diff 内容通过 DOM 文本节点渲染。

验证故事线依据 `arguments.command` 和 `arguments.cwd` 的精确关联；缺少这些元数据的旧失败记录不自动认定为已修复。无编辑重试和修改后通过使用不同文案，后续编辑/撤销会提示仍需验证。
