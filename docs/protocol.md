# Python Bridge / LAN 兼容协议

Koide 的 Windows / Android 本地应用不使用本协议；本地应用通过 Runtime API + Tauri IPC 连接 Rust Native Core。这里记录的是**可选浏览器 / LAN 兼容模式**使用的 Python Bridge WebSocket 协议。

传输：`/ws` 上的 WebSocket（JSON 文本帧），外加少量 HTTP 路由（`/api/info`、`/api/pair`、静态文件、`/animation-packs/*`）。

```text
客户端 -> Bridge  {"type":"rpc","id":1,"method":"fs.read","params":{"path":"src/a.py"}}
Bridge -> 客户端  {"type":"result","id":1,"result":{...}}
             或  {"type":"error","id":1,"error":{"code","message","data"}}
Bridge -> 客户端  {"type":"event","event":"fs.changed","data":{...}}
```

错误 `code` 是稳定英文标识（如 `CONFLICT`、`OUTSIDE_WORKSPACE`），`message` 是面向用户的中文说明。

## 安全

- 默认只绑定 `127.0.0.1`；本地模式检查 Host / Origin，避免 DNS rebinding。
- LAN 模式下，非本机连接必须使用设备令牌。
- 配对码为 6 位数字、一次有效、5 分钟过期，并限制尝试次数。
- 设备令牌只保存哈希，可过期、可 revoke。

## RPC / Events

Bridge 与 Native 使用同一组 Runtime 领域方法，以便 UI 不感知传输差异。完整公开边界以 `runtime-api.md` 为准。

主要事件包括：`fs.changed`、`fs.external`、`workspace.opened|closed`、`agent.*`、`approval.*`、`terminal.*`、`profiles.changed`、`permissions.changed`。

## Patch

```json
{"path":"src/main.ts","base_revision":"sha256:...","edits":[
  {"old_text":"return a - b","new_text":"return a + b"},
  {"range":{"start":{"line":15,"column":3},"end":{"line":21,"column":4}},"new_text":"..."}
]}
```

同一个 patch 的修改都以原始文本为基准并原子生效。`base_revision` 过期返回 `CONFLICT`，不会悄悄覆盖用户输入。

## 事务式写入

`fs.begin_write` → `fs.write_chunk` → `fs.commit_write`。提交前目标文件保持不变；中断或校验失败时原文件仍可恢复。

## 权限

HardPolicy 永远优先，其次是逐工具规则与当前权限模式。Bridge 不允许因为运行在远程模式就绕过 Workspace / Checkpoint / PermissionEngine。
