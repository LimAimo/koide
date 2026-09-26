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

当前 Runtime 共 72 个业务方法，Native dispatch 全部有明确路由。存在平台不支持的能力时必须返回明确错误或 capability=false，不能使用固定空值假装成功。
