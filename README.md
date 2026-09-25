# Diffusion IDE

> **0.8.0-alpha.4 · Native Provider 接通检查点**  
> Diffusion 正在从 Python Bridge 重构为 Tauri + Rust Native Core。产品 UI 已经通过 Runtime API 与 Bridge 解耦，Rust Workspace 已接管本地文件读写、Patch、Trash、Checkpoint 与事务式大文件写入的主体；Native Provider Profiles、模型列表与连接测试也已开始由 Rust Core 直接处理。Android / Windows 构建已经迁移到 GitHub Actions，并会在双平台成功后自动发布 prerelease。完整计划见 `docs/NATIVE_CORE_SPEC.md`，当前迁移进度见 `docs/MIGRATION_STATUS.md`。
>
> **这个 alpha 还没有完成 Python 删除线。** 旧 Bridge 仍作为迁移期兼容实现和回归测试基准存在；不要把它理解为最终架构。原生构建说明见 `docs/NATIVE_BUILD.md`。


一个本地优先、手机和电脑都能用的 AI IDE。AI 改代码时，代码不是"啪"地闪一下：留下来的部分会**移动**到新位置，
被删掉的部分会**消散**，新增的部分会在腾出来的空位里**慢慢成形**。智能体可以读代码、搜索、修改文件、运行构建和测试；
每一步你都能看见，可以随时停止，也可以撤销。

> v0.7 的功能完成度记录仍保留在 `docs/STATUS.md`；0.8 Native Core 的迁移状态以 `docs/MIGRATION_STATUS.md` 为准。

## 迁移期快速开始（旧 Bridge 兼容模式）

在 Native Core 全部替代 Python 之前，旧功能回归仍可用 **Python 3.10 或更高版本**启动。不需要 Node，不需要 pip 安装，也不需要构建。（想用更强的 CodeMirror 6 编辑器，见下面的 pnpm 章节，那一步是可选的。）

**安卓（Termux）**
```bash
pkg install python
bash start.sh
```
**Linux / macOS：** `bash start.sh`　**Windows：** 双击 `start.bat`　**任意系统：** `python bridge/main.py`

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

## 开发者：pnpm 工作区与 CodeMirror 6（可选）

项目用 **pnpm 工作区**组织（`pnpm-workspace.yaml`），需要 Node 20+ 和 pnpm 9+。

```bash
corepack enable          # 推荐：Node 自带的 corepack 会按 package.json 里的版本准备好 pnpm
# 或者手动安装 pnpm：https://pnpm.io/installation
pnpm install             # 首次运行会生成 pnpm-lock.yaml，请把它一起提交到 Git
pnpm build:cm6           # 下载并打包 CodeMirror 6，生成 apps/web/vendor/cm6.js
pnpm start               # 启动桥接服务并打开浏览器
pnpm test                # 运行全部测试
```

`pnpm build:cm6` 会自动从 npm 下载 CodeMirror 6，你不需要手动下载任何东西。参考地址：
CodeMirror 官网 https://codemirror.net/ 　npm 主页 https://www.npmjs.com/package/codemirror 　源码 https://github.com/codemirror/dev

构建完成后，重新加载页面即可：设置 › 编辑器 › 「编辑器内核」默认为「自动」，检测到 `vendor/cm6.js` 就会切换到 CodeMirror 6
（带来代码折叠、按语言补全、多行注释和字符串的语法高亮、更好的输入法与触屏支持、上百种语言）。没有构建时会继续使用内置的轻量编辑器。
安卓 Termux 里也可以装 pnpm，但只构建一次就够了：可以在电脑上构建好，把 `apps/web/vendor/` 整个文件夹拷到手机上。

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
  src/editor/                 内置编辑器与语法高亮   src/components/  界面组件   src/services/  状态与桥接客户端
packages/editor-cm6/  可选的 CodeMirror 6 适配器（pnpm 构建，输出到 apps/web/vendor/）
animation-packs/      由桥接服务提供的额外 JSON 动画包
docs/                 协议、编辑器适配、进度状态       tests/   Python 与 Node 测试
pnpm-workspace.yaml   pnpm 工作区定义（apps/*、packages/*）
```

## 主要功能
智能体（读 / 搜 / 改 / 运行命令，多步循环，限制与停止）· 三种模型接口（OpenAI 兼容、Anthropic 原生、Gemini 原生）·
四种权限模式 + 硬性安全规则 + 路径与命令规则 + 审批模型 · 时光机（重播 / 撤销单步 / 单文件 / 整个任务）· 会话历史与全局指令 ·
Git 面板（改动、差异、暂存、提交、分支、拉取推送、追溯）· 真正的 PTY 终端（多标签、颜色、快捷键行）·
导入导出 · 查找替换、括号自动补全、词语补全、分屏、缩略图 · 扫码配对 · 可关闭的 AI 面板与「返回首页」 · 手机与电脑自适应布局 · PWA。

## 测试
`bash tests/run-all.sh` 或 `pnpm test`（只有测试需要 Node 20+）。

## 已知限制
- **没有在真实的安卓设备或浏览器上试过**（只在自动化的模拟 DOM 环境里验证过），首次启动可能有粗糙的地方。
- CodeMirror 6 适配器需要联网构建，编写时没有条件在真实浏览器里运行，属于「未经验证」。
- 内置编辑器没有代码折叠（CodeMirror 版有，但未经验证）；「块」识别是按缩进和括号推断的，不是真正的语法树。
- 终端不支持 vim、htop 这类全屏程序；Windows 上没有 PTY，会退回一次性命令模式。
- 字体使用系统字体，不会下载任何东西。
