# Runtime API

Runtime API 是 UI 与执行环境之间唯一允许的边界。

UI 使用：

```js
import { runtime } from "./services/runtime/index.js";

await runtime.files.read({ path: "src/main.js" });
await runtime.git.status();
runtime.on("fs.changed", handler);
```

当前适配器：

- `NativeRuntimeAdapter`：Tauri IPC → Rust Native Core；
- `BridgeRuntimeAdapter`：迁移期兼容层 → v0.7 Python Bridge。

产品组件不允许 import `services/bridge.js`。远程连接以后会增加独立的 `RemoteRuntimeAdapter`，不会把 WebSocket 再塞回 Native Core 的本地调用路径。


## Workspace location（alpha.7）

`workspace.open` 为兼容旧调用仍接受 `{ path: "..." }`；Native 还支持结构化 `location`：

```js
await runtime.workspace.open({ location: { kind: "local", path: "C:/project" } });
await runtime.workspace.open({ location: { kind: "saf", uri: "content://...", name: "project" } });
```

Android 原生界面需要系统选择目录时，发送 `{ location: { kind: "saf", pick: true } }`；NativeCore 会调用 SAF picker，并把最终 `{ kind, uri, name }` 写入 recent。SAF URI 不是 POSIX path，UI 和 Core 都不得把它拼成 `PathBuf`。

`workspace.opened` 的 `workspace` 信息包含 `backend`、`location` 和 `capabilities`。当前 SAF capability 为 Git=false、terminal_cwd=false；调用依赖普通 cwd 的 Git/Terminal RPC 会返回明确的 `WORKSPACE_CAPABILITY`，而不是把 URI 当空路径执行。
