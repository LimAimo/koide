# Diffusion IDE

> **0.8.0-alpha.7 · Native 功能等价收口（开发中）**  
> Diffusion 正在从 Python Bridge 重构为 Tauri + Rust Native Core。当前 Runtime API 72 个业务方法已经做到 **72 / 72 Native dispatch 覆盖**；这不代表 Python 删除线已经通过——`devices.pair_code` 仍明确返回 `LAN_OFF`，Remote Runtime 等语义门禁仍未完成。Workspace / Files / Trash / Checkpoint、Provider Profiles、Conversations、chat/read/edit/agent 四种模式、PermissionEngine、Instructions、Git、Terminal/Process/Ports、Export 与 External Watcher 已进入本地 Native 主链。Android SAF 原地 WorkspaceBackend 也已进入源码并通过当前 Alpha7 的 Rust / Windows / Android CI：系统目录选择器、持久 URI 授权、DocumentsContract I/O、revision/conflict、search/glob、Checkpoint/Trash、recent 和 Git/Terminal capability 降级均已接线；真实 Android 设备 smoke 仍是最终门禁之一。完整门禁见 `docs/NATIVE_PARITY_AUDIT.md`。
>
> **这个 alpha 仍然没有完成 Python 删除线。** 旧 Bridge 继续作为迁移期兼容实现和行为基准；在 `docs/NATIVE_PARITY_AUDIT.md` 的硬门禁全部通过前不会删除。原生构建说明见 `docs/NATIVE_BUILD.md`。


一个本地优先、手机和电脑都能用的 AI IDE。AI 改代码时，代码不是"啪"地闪一下：留下来的部分会**移动**到新位置，
被删掉的部分会**消散**，新增的部分会在腾出来的空位里**慢慢成形**。智能体可以读代码、搜索、修改文件、运行构建和测试；
每一步你都能看见，可以随时停止，也可以撤销。

> v0.7 的功能完成度记录仍保留在 `docs/STATUS.md`；0.8 Native Core 的迁移状态以 `docs/MIGRATION_STATUS.md` 为准。

## 迁移期快速开始（旧 Bridge 兼容模式）

在 Native Core 全部替代 Python 之前，旧功能回归仍可继续使用 Python Bridge。**CodeMirror 6 现在是唯一正式编辑器**，因此首次运行需要 Node 20+、pnpm 9+ 与 `pnpm install`；`start.sh`、`start.bat`、`pnpm start` 和 Tauri 原生构建都会先生成 CM6 产物。Python 运行时本身仍只要求 Python 3.10+，且不需要 pip 安装第三方包。

**安卓（Termux）**
```bash
pkg install python nodejs-lts
corepack enable
pnpm install
bash start.sh
```
**Linux / macOS：** 首次执行 `pnpm install`，之后 `bash start.sh`。**Windows：** 首次执行 `pnpm install`，之后双击 `start.bat`。如果直接执行 `python bridge/main.py`，请先确保已经运行过 `pnpm build:cm6`。

浏览器会自动打开 `http://127.0.0.1:8765`。（请不要直接双击 `index.html`，它必须由桥接服务提供。）

## 第一次使用
1. **只想看看效果？** 在开始页面点「播放演示」。
2. **打开项目：** 点「打开文件夹」，选择运行桥接服务的那台电脑上的文件夹。
3. **添加 AI 服务商：** 设置 › AI 模型服务商 › 添加服务商配置。可选 OpenAI、DeepSeek、Kimi、OpenRouter、Ollama，
   或任何兼容 OpenAI 的接口。密钥只保存在桥接服务里，页面永远拿不回来。
4. 在聊天框里说出目标，比如「找出构建失败的原因并修复」。
5. 用顶部的**时光机**（时钟图标）查看结果：可以重播任意一步，撤销某一步、某个文件，或者整个任务。

## 用手机操作电脑上的项目
在电脑上运行 `python bridge/main.py --lan`，然后打开 设置 › Python 桥接 › 「显示配对码和二维码」，**用手机相机扫码**即可自动配对并连接。
也可以手动配对：在手机上打开终端里打印的地址，进入 设置 › Python 桥接 › 「配对这台设备」，输入配对码。已配对的设备可以随时在电脑上撤销。
局域网模式默认关闭；不加 `--lan` 时，桥接服务只监听 `127.0.0.1`。

## 安全机制
- 四种权限模式：**严格**、**手动**、**AI 审批**（由另一个模型来审查）、**自主**。
- 所有模式之上还有一层固定的**硬性安全规则**：不能删工作区之外的东西、不能修改正在运行的桥接服务、
  碰到凭据要先问你、危险的 shell 命令直接拦截或要求确认。智能体、审批模型、「始终允许」都绕不过它。
- 每个智能体任务都会建立检查点。删除的文件先进 Diffusion 回收站。每次修改都带着基础版本号，
  所以 AI 永远不会悄悄覆盖你刚刚输入的内容。
- shell 可以运行任何你批准的命令。使用「自主」模式时，请像对待任何脚本运行器一样谨慎。

## 开发者：pnpm 工作区与 CodeMirror 6

项目用 **pnpm 工作区**组织（`pnpm-workspace.yaml`），需要 Node 20+ 和 pnpm 9+。

```bash
corepack enable          # 推荐：Node 自带的 corepack 会按 package.json 里的版本准备好 pnpm
# 或者手动安装 pnpm：https://pnpm.io/installation
pnpm install             # 首次运行会生成 pnpm-lock.yaml，请把它一起提交到 Git
pnpm build:cm6           # 打包 CodeMirror 6，生成 apps/web/vendor/cm6.js
pnpm start               # 先构建 CodeMirror 6，再启动桥接服务并打开浏览器
pnpm test                # 运行全部测试
```

`pnpm build:cm6` 会自动从 npm 下载 CodeMirror 6，你不需要手动下载任何东西。参考地址：
CodeMirror 官网 https://codemirror.net/ 　npm 主页 https://www.npmjs.com/package/codemirror 　源码 https://github.com/codemirror/dev

CodeMirror 6 不再是可选内核：产品界面固定使用它（代码折叠、按语言补全、多行注释和字符串的语法高亮、更好的输入法与触屏支持、上百种语言）。如果 `vendor/cm6.js` 缺失或加载失败，编辑器会明确显示错误，而不会偷偷退回 textarea。Tauri 的 `beforeBuildCommand` / `beforeDevCommand` 会自动执行 CM6 构建；Bridge 启动脚本也会先构建。`apps/web/vendor/` 仍是生成目录，不提交到 Git。

| 命令 | 作用 |
|---|---|
| `pnpm start` | 启动桥接服务 |
| `pnpm build` / `pnpm build:cm6` | 构建全部包 / 只构建 CodeMirror 适配器 |
| `pnpm watch:cm6` | 修改适配器后自动重新打包 |
| `pnpm test` / `test:bridge` / `test:web` | 全部 / 仅 Python / 仅 Node 测试 |

## 目录结构
```
apps/native/          Tauri 2 + Rust Native Core（0.8 迁移主线）
apps/web/src/services/runtime/  UI 唯一运行时边界；Native / Bridge 适配器
bridge/               Python 服务（只用标准库）：文件系统、安全规则、模型接口、智能体、检查点、Git、终端
apps/web/             网页界面，纯 ES 模块（无需构建，由桥接服务直接提供）
  src/animations/diffusion/   引擎（纯逻辑）、渲染器、动画包
  src/editor/                 编辑器适配器测试/动画辅助   src/components/  界面组件   src/services/  状态与运行时
packages/editor-cm6/  正式 CodeMirror 6 编辑器适配器（pnpm 构建，输出到 apps/web/vendor/）
animation-packs/      由桥接服务提供的额外 JSON 动画包
docs/                 协议、编辑器适配、进度状态       tests/   Python 与 Node 测试
pnpm-workspace.yaml   pnpm 工作区定义（apps/*、packages/*）
```

## 主要功能
智能体（读 / 搜 / 改 / 运行命令，多步循环，限制与停止）· 三种模型接口（OpenAI 兼容、Anthropic 原生、Gemini 原生）·
四种权限模式 + 硬性安全规则 + 路径与命令规则 + 审批模型 · 时光机（重播 / 撤销单步 / 单文件 / 整个任务）· 会话历史与全局指令 ·
Git 面板（改动、差异、暂存、提交、分支、拉取推送、追溯）· 真正的 PTY 终端（多标签、颜色、快捷键行）·
导入导出 · CodeMirror 6、查找替换、分屏 · AI 创建/修改文件时可自动打开并定位到改动 · 扫码配对 · 可自由拖动高度的移动端 AI 抽屉与「返回首页」 · 手机与电脑自适应布局 · PWA。

## 测试
`bash tests/run-all.sh` 或 `pnpm test`（只有测试需要 Node 20+）。

## 已知限制
- Android / Windows 原生安装包与 SAF WorkspaceBackend 已通过当前 Alpha7 CI；真实 Android 设备上的 SAF 打开 → 编辑 → Agent → Checkpoint 仍需最终 smoke。
- CodeMirror 6 的真实依赖构建已加入 Alpha7 CI 门禁；离线源码环境如果尚未生成 `apps/web/vendor/cm6.js`，必须先安装依赖并执行 `pnpm build:cm6`。
- Windows Native PTY 已接通；Android interactive PTY 仍在迁移，SAF 工作区也会明确禁用依赖普通 cwd 的 Terminal/Git 能力，不伪装支持。
- 字体使用系统字体，不会下载任何东西。
