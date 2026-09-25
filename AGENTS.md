# AGENTS.md：给参与本项目的 AI 编程智能体

## 这是什么
一个本地优先的 AI IDE。`bridge/` 是 Python（仅标准库）服务；`apps/web/` 是无需构建的 ES 模块网页应用；
`animation-packs/` 存放声明式 JSON 动画包。开始之前请先读 `docs/protocol.md` 和 `docs/STATUS.md`。

## 绝对不能破坏的规则
1. 永远不要从文本里解析工具调用。工具参数由模型接口的数据块拼装，且只有收到接口明确的结束信号后才执行（见 `bridge/providers/openai_compat.py`）。
2. 所有文件修改都必须经过 `Workspace`（沙箱、版本检查、检查点、回收站）。工具里不许直接写文件。
3. `bridge/security/policy.py`（硬性安全规则）高于智能体、审批模型和用户设置，不要添加任何绕过方式。
4. 不许智能体修改正在运行的桥接服务或 `~/.diffusion-ide`（自我保护）。
5. Diffusion 不相信 AI 自述的编辑意图：对应关系只能来自前后文本本身。低于阈值的匹配必须降级为「删除 + 新增」或淡入淡出，绝不能猜。
6. 动画包只是数据。`validatePack` 必须保持白名单机制。
7. 不许做成单个 HTML 文件；不许用 `file://` 运行；不许把不可信文本塞进 `innerHTML`（请用 `h()` 和文本节点）。
8. 手机是一等目标平台：触控区域至少 40px，不依赖悬停，尊重「减少动态效果」。
9. **界面文字和文档一律使用中文**（面向模型的提示词和工具描述可以保留英文）。

## 目录
- `bridge/`：服务；`filesystem/`、`checkpoint/`、`security/`、`providers/`、`tools/`、`agent/`、`process/`
- `apps/web/src/animations/diffusion/`：引擎（纯逻辑、不碰 DOM）、渲染器（DOM）、动画包
- `apps/web/src/editor/`：编辑器适配器与高亮；`components/`：界面；`services/`：状态与桥接客户端
- `packages/editor-cm6/`：可选的 CodeMirror 6 适配器（pnpm 构建到 `apps/web/vendor/`）
- `tests/`：Python unittest 与 Node `node:test`

## 常用命令
- 运行：`python bridge/main.py`（或 `bash start.sh`、`pnpm start`）
- 全部测试：`bash tests/run-all.sh`（或 `pnpm test`）
- 包管理器是 **pnpm 工作区**（`pnpm-workspace.yaml`）：`pnpm install`、`pnpm build:cm6`。不要改用 npm 或 yarn，也不要提交 `node_modules/` 和 `apps/web/vendor/`。
- `apps/web` 里的网页模块是普通 ES 模块，没有构建步骤，import 请使用显式相对路径（`./x.js`）。
- 编辑器只能通过适配器接口使用（见 `docs/editor-adapters.md`）；不要在界面层直接访问某个编辑器的内部对象（比如 textarea）。

## 约定
- Python：类型标注，`from __future__ import annotations`，不引入第三方依赖。
- JS：不用框架；组件是返回元素的函数；长期状态放在 `services/`。
- 每次行为变化都要补测试；Diffusion 引擎有一个随机测试，必须保持通过。
