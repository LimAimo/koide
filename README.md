# Koide

> **1.0.0-rc.2 · 候选版准备（dev/1.0.0，尚未发布）**  
> Koide 是一个本地优先、面向桌面与 Android 的 AI IDE。正常本地使用由 **Tauri 2 + Rust Native Core** 驱动，不需要 Python、localhost 或 WebSocket；Python Bridge 仅保留为浏览器/LAN 兼容模式。

AI 修改代码时，Koide 不只是瞬间替换文本：保留下来的代码会移动到新位置，被删除的内容会消散，新增内容会在新位置成形。智能体可以读代码、搜索、修改文件、运行命令与测试；每一步都有权限边界、检查点和可恢复路径。

## 主要能力

- **本地 Native Core**：Workspace、Files、Trash、Checkpoint、Profiles、Conversations、Agent、Permissions、Instructions、Git、Terminal/Process、Ports、Export 与文件变更监听均由 Rust 主链提供。
- **四种 AI 模式**：聊天 / 只读 / 编辑 / 智能体；支持 `ask_user`、工具审批、任务停止、上下文延续和限制策略。
- **多服务商**：OpenAI / OpenAI-compatible、DeepSeek、Kimi、OpenRouter、Ollama、Anthropic、Gemini、MiniMax 等。
- **CodeMirror 6**：正式编辑器，支持查找替换、分屏、语言高亮、代码折叠与移动端输入。
- **Git 与终端**：Windows 本地工作区支持 Git 主流程和交互式 PTY；Android 普通本地工作区支持一次性 shell 命令。
- **Android SAF**：可以原地打开用户授权目录，保留 revision、冲突检测、Checkpoint、Trash 与 Agent 编辑语义。
- **移动端界面**：AI 抽屉支持半屏、自由高度、可中断的阻尼吸附和向上 fling 全屏；状态栏安全区、触控和移动布局均单独适配。
- **统一 Motion System**：导航、浮层、按钮按压、AI 面板、工作现场和 Time Machine 共用一套响应节奏，并尊重 reduced-motion；代码 Diffusion 动画保持独立。
- **克制的声音与触觉**：Android 原生触觉用于吸附、确认、完成和恢复；提示音默认关闭，仅在前台完成/恢复时播放。可在设置中独立控制，后台与重复事件不补播。
- **工作现场与项目记忆**：实时显示 Agent 真正发生的探索、修改与验证阶段；项目可维护显式的 `.koide/PROJECT_MEMORY.md` 长期上下文，并保护外部修改冲突。
- **可追踪 Time Machine**：探索、文件修改和验证节点会关联真实 Tool Call；验证失败后的修复与重新通过会形成可读故事线，支持文件增删统计、行范围、内联 Diff、区域跳转及单步/单文件/整任务恢复。新记录保存修改前后快照，旧记录无法核对时会明确提示。
- **安全与恢复**：HardPolicy、权限模式、逐工具规则、审批模型、版本冲突检测、时光机和回收站共同工作。

## 快速开始

### 原生应用（推荐）

先安装 Node.js 22+ 与 pnpm 9+：

```bash
corepack enable
pnpm install
pnpm build:cm6
```

桌面开发：

```bash
pnpm native:dev
```

Windows 构建：

```bash
pnpm native:build
```

Android ARM64 构建需要 Java 21、Android SDK 36、Build Tools 36.0.0 与 NDK `27.3.13750724`：

```bash
pnpm --filter @diffusion/native exec tauri android init
pnpm --filter @diffusion/native exec tauri android build --debug --apk --target aarch64
```

更完整的工具链与 CI 说明见 `docs/NATIVE_BUILD.md`。

### 浏览器 / LAN 兼容模式

Python Bridge 不再是本机原生应用的依赖，但仍可用于浏览器访问或让手机连接电脑上的项目：

```bash
pnpm start
# 或
python bridge/main.py --open
```

局域网模式：

```bash
python bridge/main.py --lan
```

Bridge 默认只监听 `127.0.0.1`；LAN 模式使用一次性配对码与设备令牌。协议见 `docs/protocol.md`。

> 不要直接双击 `apps/web/index.html`。Koide Web 使用 ES Modules，需要通过 HTTP(S) 或 Tauri WebView 加载。

## 第一次使用

1. 在开始页打开项目目录；Android 可以选择 SAF 授权目录，也可以使用 Koide 私有工作区。
2. 在「设置 › AI 模型服务商」添加服务商配置。
3. 选择聊天 / 只读 / 编辑 / 智能体模式，并告诉 Koide 目标。
4. 需要写文件、运行命令或进行高风险操作时，权限引擎会按当前模式处理。
5. 点击顶部工作状态进入「工作现场」，或使用「时光机」追踪真实工具调用、验证失败/修复/成功过程，并按事件、文件或整项任务恢复。
6. 需要跨任务保留项目事实时，在「项目记忆」维护 `.koide/PROJECT_MEMORY.md`；外部修改造成 revision 冲突时，Koide 会保留编辑框内容并要求重新载入/合并。

## 架构

```text
apps/web UI
    │
    ▼
Runtime API
    ├── NativeRuntimeAdapter ── Tauri IPC ── Rust Native Core
    └── BridgeRuntimeAdapter ── WebSocket ── Python Bridge（可选兼容模式）
```

产品组件只依赖 Runtime API，不直接依赖 Bridge。当前架构约束见 `docs/NATIVE_CORE_SPEC.md`，运行时接口见 `docs/runtime-api.md`。

## 安全机制

- 四种权限模式：**严格 / 手动 / AI 审批 / 自主**。
- HardPolicy 始终高于用户设置、审批模型和智能体本身。
- 所有工作区文件修改都必须经过 Workspace 边界、revision 检查与 Checkpoint。
- 删除和破坏性恢复优先进入 Koide 管理的回收站；不会因为智能体处于自主模式就绕过安全层。
- API Key 不回传给前端；Native 模式保存在应用私有数据目录。

## 平台差异与已知限制

- **Android SAF**：文件编辑、搜索、Checkpoint、Trash 与 Agent 编辑可用；由于 SAF URI 不是普通 cwd，Git 与 Terminal cwd 会明确标记为不可用。
- **Android 交互式 PTY**：当前仍未提供；一次性 shell 命令可用。
- **Native Remote Runtime**：本机 Rust Core 暂未提供 LAN server / 一次性配对码。需要跨设备访问时继续使用可选 Python Bridge。
- **Provider 停止**：流式请求会检查停止状态，但同步网络读取期间的中止不是所有服务商都能做到瞬时返回。
- CI 的 Android APK 使用可安装的调试签名；正式商店签名需要单独配置发行密钥。

这些限制不会阻止 Koide 作为本地 Native IDE 使用；当前能力矩阵见 `docs/STATUS.md` 与 `docs/NATIVE_PARITY_AUDIT.md`。

## 开发与测试

```bash
pnpm build:cm6
node --test tests/web/*.test.mjs
python3 -m unittest discover -s tests/bridge -v
cd apps/native/src-tauri && cargo test --lib
```

CI 会额外验证 Runtime API / Native dispatch 对齐，并构建 Windows x64 与 Android ARM64 成品。

## 目录结构

```text
apps/native/                         Tauri 2 + Rust Native Core
apps/web/                            Web UI（纯 ES Modules）
apps/web/src/services/runtime/       UI 唯一运行时边界
packages/editor-cm6/                 CodeMirror 6 适配器
bridge/                              可选 Python Bridge / LAN 兼容实现
animation-packs/                     声明式动画包
docs/                                架构、构建、Runtime API、平台说明
tests/                               Web、Bridge 与集成回归测试
```

项目内部仍保留少量 `diffusion-*` 包名、数据目录名与动画命名，用于兼容既有安装和历史数据；这些内部标识属于兼容层，不再作为产品名称。

## 1.0 收尾与后续路线

当前 Product Polish Pass 已实现面板释放/吸附、连续状态、Time Machine Rich Diff、Android 语义触觉与可选提示音，并收敛设置页和文件树的连续操作与错误状态。全局视觉与真机验收尚未全部完成。逐项完成度、CI 记录和 RC 验收项见 [产品打磨记录](docs/PRODUCT_POLISH.md)，反馈行为见 [声音与触觉](docs/FEEDBACK.md)。1.x 的语义索引、上下文固定、任务恢复、执行图等按版本逐步推进，见 [路线图](docs/ROADMAP.md)；这些规划不代表当前已经实现。
