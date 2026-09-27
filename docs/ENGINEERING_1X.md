# Koide 1.x 工程视图

版本：1.4.0-alpha.1。日期：2026-09-28（北京时间）。本轮按用户明确要求提前实现原 1.1–1.4 范围；这是开发预览，不是 1.4 稳定发行。开发仍在 `dev/1.0.0`，不合并 main，不创建 Release/Tag。

## 从哪里开始

顶栏「工程」包含任务、上下文、索引与架构、沙箱、界面五个视图。聊天输入区显示固定上下文数量；工作现场可打开执行图；时光机可打开工程记录、Why 与历史分叉。

| 能力 | 当前实现 | 边界 |
|---|---|---|
| Semantic Project Index | 使用 CodeMirror/Lezer 的真实语法树解析 JS/TS、Python、Rust 等受支持源文件，提取定义、作用域、引用、调用、导入和配置属性；具名导入别名可关联定义 | 是语法与静态绑定索引，不是编译器/LSP 的完整类型分析。动态成员、外部依赖、歧义明确保留，不虚构调用目标 |
| Architecture Map | 从实际索引生成模块/符号关系与图上连线；连接 UI Runtime 调用、Runtime 方法、Native dispatch 与 Bridge RPC 入口；点击定位源码 | 未解析的 Rust 接收器或动态 JS 不能声称已追到最终实现；入口及原始代码位置仍可查看 |
| Context Pin | 固定保存文件、函数/类行范围、编辑器未保存草稿、报错、日志/终端文本、Git Diff、Checkpoint、Inspector 结果；查看来源、禁用或移除 | 24 项、单项 24000 字、合计 64000 字。固定的是明确快照；来源 revision 变化会标记。移除影响下次任务，不能收回模型已读内容 |
| Persistent Task | 任务目标、上下文快照、计划修订、所有实际工具尝试/结果、修改、验证及子任务持久保存；关闭后可查看并续接；任务历史支持分页读取 | 续接创建关联的新执行，不重放未确认工具调用。运行环境重启后遗留的 running 标为 interrupted。Provider 沉默读取的取消延迟仍存在 |
| Plan / Execution Graph | 模型通过结构化 task_plan 发布读取、修改、验证和依赖；修改/执行命令/分派前要求有计划；实际调用用 plan_node_id 关联；旧计划保留为已替换 | 节点「关联动作已完成」只描述实际调用，不替模型宣称整个意图正确。错误、缺结果、部分执行、未执行分开；无关联的动作仍保留 |
| Investigation | 记录观察、假设、实验方案、结论；证据引用实际 tool_result 的调用 ID；支持支持/排除/尚无结论 | 是模型公开的工程判断，不是隐藏思维链。结论及支持/排除需要证据，不允许引用不存在的调用 |
| Why? | 读取任务目标、当时计划理由、实际参数、结果和修改节点，明确区分「计划中的理由」与已发生事实 | 未记录理由时直接说明缺失，不编造解释 |
| Local AI Review | 用户从工程面板启动只读工作区 Diff 审查；模型用 review_report 提交有调用证据的发现；结束后顶栏安静显示数量，源码变化标记过期 | 不后台自动反复调用模型。无发现不等于证明安全；报告必须说明实际审查范围 |
| 多 Agent | 主 Agent 调用 delegate_tasks；最多 4 个真实子任务，独立模型上下文与调用记录；独立任务并行、依赖失败则跳过；编辑子任务各用独立 worktree | 一层分派，子任务不能再次分派；每项最多 24 次工具调用、300 秒（父限制更小时取更小值）。停止父任务会协作式停止子任务；权限/HardPolicy 继续逐次生效 |
| Worktree Sandbox | Git detached worktree；编辑、模型调用、验证留在沙箱；用户查看 Rich Diff 后应用；主工作区冲突和沙箱内容变化阻止应用 | 创建需要干净且已有提交的本地 Git 仓库；SAF、符号链接、子模块、二进制/权限变化明确降级。Git worktree 是文件工作区隔离，不是进程级安全隔离 |
| Checkpoint Branching | 从时光机节点创建独立方案；记录源任务/事件与基准提交；对同基准 A/B 比较 Diff、文件数、验证与任务耗时 | 必须有新任务记录的干净 Git 起点与 after_blob。恢复依据基准提交和已记录修改，不补造未记录的外部动作。旧任务缺基准时拒绝 |
| AI UI Inspector | 点选当前 Koide 或接入预览中的实际元素，读取 DOM、匹配 CSS、创建位置/处理器及显式注册的组件状态；固定给 Agent | 无源码映射/状态注册时显示缺失。不能读取闭包变量，也不假装能从任意第三方网页恢复完整组件信息 |
| Visual Regression | 保存视口/主题分组的前后布局测量，比较新增、移除、位移/尺寸与裁切；可导入真机截图或由浏览器授权捕获；声明预期变化后可交给只读 Agent 调查 | 不同视口/主题不能误作同一基线。截图不同本身只是提示。浏览器/WebView 不支持屏幕捕获时仍可测量/导入，不伪造截图 |

## 索引与上下文

首次非聊天任务会建立缺失的索引。也可在索引页手动更新/取消。索引保留 source revision，Agent 查询返回当前 revision，编辑仍必须读取当前文件。它不把所有源文件全文自动发给模型。

目录遍历排除 Git、依赖、构建产物及 Koide 内部目录；最多 400 个源文件/目录访问、12 MB 源文本，单文件 500000 字、语法节点有预算，持久索引约 7.5 MB 预算。达到预算、解析错误和读取失败均反映在覆盖信息中，不宣称全项目索引成功。

Project Memory 仍是用户显式维护的 `.koide/PROJECT_MEMORY.md`。固定上下文和任务记录存在项目对应的应用数据目录，**不会自动写入项目记忆，也不会把聊天摘要伪装成长期知识**。

## 沙箱审查与应用

沙箱目录是应用数据目录旁的 `koide-worktrees/<id>`，不把源码工作树混入密钥/权限/检查点数据目录。操作只能使用当前项目登记的 ID，不能传任意路径。创建与检查使用 Git 参数数组，禁用 checkout hooks；普通修改经 Workspace。

沙箱的验证记录在真实 `shell_run` 成功后保存当时 Git HEAD 与文件 revision 的指纹。后续修改会使验证失效；移动 HEAD 会阻止自动应用。主工作区每个受影响文件必须仍匹配基准；应用不移动主工作区 HEAD，不自动提交或合并。应用过程创建检查点，删除进回收站。如果 I/O 在中途失败，不能宣称整批成功，已变更文件可从该检查点恢复。

编辑子任务不会直接修改主工作区，也不会自动合回。可以在沙箱审查页填写进一步目标/验证命令，交给真实子 Agent 执行。任务耗时包含模型和等待时间，不是程序性能基准。

## 预览接入

同源预览可直接检查。跨域项目需由开发者明确允许 Koide 的 origin：

```js
import { installInspectorBridge, registerComponent } from "https://你的-koide-地址/src/services/inspection.js";
installInspectorBridge("https://你的-koide-地址");
registerComponent(button, {
  component: "提交按钮",
  source: { path: "src/submit.js", line: 20 },
  state: () => ({ pending: form.pending })
});
```

只注册希望暴露给 Inspector 的状态，不注册密钥。消息检查 origin、窗口身份和本次 nonce；不接受任意代码执行。iframe 能否加载还受被预览项目的 CSP / frame-ancestors 与浏览器限制。手机/平板/桌面选项改变预览 iframe 的真实视口；主题由被预览应用自身切换。

截图由用户选择或导入，需确认画面对应当前场景；不会声称浏览器授权截图一定来自某个未确认的标签。可保存 6 个场景，记录受 8 MB 总容量保护。

## 代码与验证

- 共享工具契约：`koide_contracts/engineering-tools.json`，Rust 编译时载入，Python 包携带相同资源。
- Native：`core/engineering.rs`、`core/sandbox.rs`、`core/agent.rs`。
- Bridge：`bridge/agent/engineering.py`、`sandbox.py`、`runtime.py`。
- UI：`components/engineering.js`、`services/engineering.js`、`inspection.js`、`visual-regression.js`。
- 语法树分析：`packages/editor-cm6/src/semantic.js`，继续使用现有语言包，不新增分析服务依赖。

按用户要求不运行本地测试或构建。新增计划/证据/历史范围、revision 冲突、沙箱验证与主工作区冲突、语法定义/别名、视觉预期变化回归；旧模拟 Provider 更新为先发结构化计划，避免把新门禁关闭以迁就旧用例。实际通过与否以本次提交 CI 为准，真机触感/安全区和全局视觉验收不冒充已完成。
