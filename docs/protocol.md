# Legacy Bridge 协议（迁移期）

> 这是 v0.7 Python Bridge 的 WebSocket 协议文档。0.8 本机 Native 模式不再使用 localhost/WebSocket；UI 通过 `docs/runtime-api.md` 描述的 Runtime API 与 Tauri IPC 连接 Rust Core。本协议未来只可能作为可选 Remote Runtime 的参考，不再是本地核心协议。

传输：`/ws` 上的 WebSocket（JSON 文本帧），外加少量 HTTP 路由（`/api/info`、`/api/pair`、静态文件、`/animation-packs/*`）。

```
客户端 -> 桥接  {"type":"rpc","id":1,"method":"fs.read","params":{"path":"src/a.py"}}
桥接 -> 客户端  {"type":"result","id":1,"result":{...}}   或   {"type":"error","id":1,"error":{"code","message","data"}}
桥接 -> 客户端  {"type":"event","event":"fs.changed","data":{...}}
```
错误的 `code` 是稳定的英文标识（如 `CONFLICT`、`OUTSIDE_WORKSPACE`），`message` 是给用户看的中文说明。

## 安全
- 默认只绑定 `127.0.0.1`。本地模式要求 `Host` 头是回环地址（防 DNS 重绑定），并要求 `Origin` 与页面同源。
- 局域网模式：非本机的连接必须持有设备令牌，令牌通过 `POST /api/pair {code,name}` 获得。配对码为 6 位数字，一次有效，
  5 分钟内可用，最多尝试 5 次。令牌以哈希形式保存，30 天后过期，可用 `devices.revoke` 撤销。

## RPC 方法
`hello`、`workspace.open|close|browse`、`fs.read|tree|search|hash|write|patch|create|delete|rename|copy`、
`fs.begin_write|write_chunk|commit_write|abort_write`、`trash.list|restore|delete|empty`、
`checkpoint.tasks|task|diff|revert_file|revert_task|revert_event`、`profiles.list|save|delete|test`、
`permissions.set`、`approval.respond`、`agent.start|stop|answer`、`instructions.constitution`、`git.reset`、`terminal.run|kill`、`devices.pair_code|list|revoke`。

## 事件
`fs.changed`（带 `before_text` / `after_text`，`actor` 为 user|agent|system，驱动 Diffusion 动画）、`fs.external`、`workspace.opened|closed`、
`agent.started|status|message|reasoning|tool|question|question_resolved|done`、`approval.request|resolved`、`terminal.start|output|exit`、`profiles.changed`、`permissions.changed`。

## Patch 格式
两种修改写法；同一个 patch 里的所有修改都以**原始文本**为基准，并原子地一起生效：
```json
{"path":"src/main.ts","base_revision":"sha256:...","edits":[
  {"old_text":"return a - b","new_text":"return a + b"},
  {"range":{"start":{"line":15,"column":3},"end":{"line":21,"column":4}},"new_text":"..."}]}
```
行号和列号从 1 开始，`end` 不包含在内，列号按 Unicode 码点计数。`old_text` 必须恰好匹配一处，除非设置 `replace_all`。
`base_revision` 过期会返回 `CONFLICT`，文件绝不会被悄悄覆盖。

## 事务式写入
`fs.begin_write` → `fs.write_chunk {seq,data}`（严格按序号）→ `fs.commit_write {total_bytes,sha256}`。提交之前目标文件保持不变；任何中断或校验不符，原文件都完好无损。

## 权限判定顺序
1. 硬性规则拒绝 → 拒绝。2. 该工具被设为「禁止」→ 拒绝。3. 硬性规则要求询问 → 询问（即使自主模式、始终允许、审批模型说允许也一样）。
4. 该工具被设为「每次询问」→ 询问。5. 工作区内的读取类工具 → 允许。6. 该工具「始终允许」或本次会话已授权 → 允许。
7. 按模式：严格/手动 → 询问；AI 审批 → 交给审批模型（任何失败都退回询问）；自主 → 除高风险外允许。

## 模型接口的流式事件
`text`、`reasoning`、`tool_call_delta`、`tool_call_complete`、`finish`、`error`。如果流在没有结束标志时中断，尚未完成的工具调用会被丢弃。

## 交互式提问与工具准备状态
`ask_user` 是服务商原生 Tool Call 中的一种交互工具。桥接服务收到完整调用后发送 `agent.question`，任务暂停；客户端用 `agent.answer` 提交回答后继续，并发送 `agent.question_resolved`。

工具参数在服务商原生 `tool_call_delta` 中流式到达时，桥接服务可以发送 `agent.tool` 的 `preparing` 状态。这里的标题 / 摘要只提取已经完整到达的路径、命令、查询、问题等字段，不发送原始参数 JSON，也不会从模型普通文本中猜测工具调用。

## Git 回退
`git.reset {hash, mode}` 支持 `soft` 与 `hard`。`hard` 必须额外传 `confirm:true`；实现不会直接调用 `git reset --hard` 覆盖磁盘，而是通过 Workspace 沙箱恢复提交树，把会被覆盖或删除的内容移入 Diffusion 回收站，再移动 Git HEAD / index。
