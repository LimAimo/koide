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
