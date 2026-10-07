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

当前 Runtime 共 84 个业务方法，Native dispatch 全部有明确路由。存在平台不支持的能力时必须返回明确错误或 capability=false，不能使用固定空值假装成功。

## 创作工作台 API

| 领域 | 方法 | 语义 |
|---|---|---|
| 项目状态 | `studio.read` / `studio.write` | 读取/保存 `.koide/studio.json`；保存必须有 `base_revision`，经过 Workspace 和 Checkpoint；上限 2 MiB |
| 代码版本 | `studio.revision` | LocalFS / SAF 项目源码指纹，通过 Workspace 遍历与 hash；忽略依赖、生成目录、`.koide` 和敏感文件 |
| 语义重命名 | `studio.apply_edits` | `{files:[{path,revision,content}],label}`；全量预检后经 Workspace 写入，保留恢复任务；Agent 运行时拒绝并发写入 |
| 运行向导 | `launch.inspect` | 检查清单、脚本与 PATH 环境，返回每条命令相对 `cwd`，不自动执行或安装 |
| 隔离预览 | `preview.open` / `preview.close` / `preview.capture` | 本机 HTTP 服务经独立受控代理提供；截图需要已安装的 Edge / Chrome；不支持时返回 `SCREENSHOT_UNAVAILABLE` |
| 方案试验 | `experiments.list` / `create` / `diff` / `apply` | LocalFS 隔离复制、同基线创建、真实差异、冲突拒绝与可恢复应用；不复制依赖、敏感文件或符号链接 |

`terminal.run` 增加可选 `cwd`（项目内相对目录，默认 `.`）；不接受越界目录。`terminal.exit` 在输出采集结束后发送，包含 `exit_code`、`timed_out`、`cancelled`，启动失败另含 `error`。验收证据记录命令开始时的源码指纹；命令执行期间源码变化也会使证据过期。

`studio.read` / `write` 返回执行端不透明的 `workspace_key`。UI 为与当前项目关联的请求附加此值，Native / Bridge 在调用入口核对当前 Workspace；不匹配返回 `WORKSPACE_CHANGED`，避免排队的旧请求落入新项目。客户端仍用单调递增项目 epoch 丢弃异步迟到结果，覆盖 A → B → A。省略该字段的旧客户端保持兼容。

`agent.start` 增加 `attachments:[{name,data_url}]`，仅 PNG / JPEG / WebP，最多 4 张、单张 5 MiB、合计 10 MiB；Profile 必须显式设置 `vision:true`。图片只作为消息内容，不解析为工具调用。Profile 可配置 `pricing.input_per_million` 与 `pricing.output_per_million`；`agent.usage` 发布实际 Provider token 用量和按此单价的费用估算，未返回用量时保留未知。预算增加 `max_tokens`、`max_cost_usd`、`max_repeated_failures`。

预览 iframe 使用 `sandbox="allow-scripts"`，不授予同源、表单、导航或 IDE IPC。元素反馈通过 `postMessage` 发送，UI 同时校验 opaque origin、窗口身份和随机会话 token。项目关闭/切换和执行端关闭会销毁预览会话。

Native `agent.stop` 直接设置 AgentState 停止信号，不等待普通 Core dispatch 锁；响应头、SSE、AI 审批和网页读取约每 80ms 检查取消。同步平台操作在安全边界结束后返回。
