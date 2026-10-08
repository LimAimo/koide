# AGENTS.md：给参与 Koide 的 AI 编程智能体

## 这是什么
Koide 是一个本地优先的 AI IDE。`apps/native/` 是 Tauri 2 + Rust Native Core；`apps/web/` 是 UI；`bridge/` 是浏览器 / LAN 兼容模式使用的 Python Bridge；`animation-packs/` 存放声明式动画包。开始前请先读 `docs/NATIVE_CORE_SPEC.md`、`docs/runtime-api.md` 与 `docs/STATUS.md`。

## 绝对不能破坏的规则
1. 永远不要从普通模型文本里解析工具调用；只接受 Provider 的结构化 Tool Call。
2. 所有文件修改都必须经过 Workspace（沙箱、revision、Checkpoint、Trash）；工具里不许绕过它直接写工作区文件。
3. HardPolicy 高于智能体、审批模型和用户设置，不得增加绕过方式。
4. 不许智能体修改运行中的核心服务或应用私有安全数据。
5. Diffusion 动画不相信 AI 自述的编辑意图；对应关系只能来自前后文本本身。低置信匹配必须降级为删除 + 新增或淡入淡出。
6. 动画包只是数据；`validatePack` 必须保持白名单机制。
7. 不许做成单个 HTML；不支持 `file://` 运行；不可信文本禁止直接进入 `innerHTML`。
8. 手机是一等平台：触控区域至少 40px，不依赖 hover，并尊重减少动态效果。
9. **界面文字和项目文档一律使用简体中文**；面向模型的系统提示词和工具描述可以使用英文。
10. 用户可感知的新功能、行为调整、UI/交互变化和 Bug 修复必须同步写入 `CHANGELOG.md`；纯内部重构/CI 诊断可不记。

## 目录
- `apps/native/`：Tauri 壳与 Rust Native Core。
- `apps/web/src/services/runtime/`：UI 唯一运行时边界。
- `bridge/`：可选 Python Bridge / LAN 兼容实现。
- `apps/web/src/animations/diffusion/`：动画引擎与渲染器。
- `packages/editor-cm6/`：正式 CodeMirror 6 编辑器适配器。
- `tests/`：Web、Bridge 与集成测试。

## 常用命令
- `pnpm install`
- `pnpm build:cm6`
- `node --test tests/web/*.test.mjs`
- `python3 -m unittest discover -s tests/bridge -v`
- `cd apps/native/src-tauri && cargo test --lib`
- `pnpm native:dev`
- `pnpm native:build`

包管理器使用 pnpm 工作区；不要改用 npm / yarn，也不要提交 `node_modules/`、`apps/web/vendor/` 或 Rust `target/`。

## 约定
- Python：类型标注，优先标准库，Bridge 不随意新增第三方依赖。
- JS：不用框架；组件返回 DOM 元素；长期状态放在 `services/`。
- Rust：业务错误必须映射为稳定 `RuntimeError` code；平台不支持能力应显式返回错误/capability，而不是假成功。
- 编辑器只能通过适配器接口使用（见 `docs/editor-adapters.md`）。
- 每次行为变化都补测试；安全语义变化必须有回归覆盖。
- 完成更改后，请使用中文提交信息，提交到本地
- 需要升级版本号和更新更新日志时，请在 `CHANGELOG.md` 中添加条目