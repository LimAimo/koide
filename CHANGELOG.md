# 更新日志

## 1.0.0（开发中）
- **Product Polish Pass：AI 面板手感**：加入可中断的阻尼弹簧、最近移动速度判断、半屏吸附和自由高度；全屏向下快速滑动先回半屏。松手前停顿不再使用过期速度；系统取消手势或第二根手指不会误触关闭。手机面板关闭保留过渡，重新打开恢复半屏。
- **浮层与抽屉连续性**：修复文件抽屉样式覆盖跟手位置；浮层关闭立即生效，连续关闭、重开及嵌套操作不再让旧返回事件误关新浮层。对话框异步操作防重复提交，菜单选择防连点；扩大触屏把手和小按钮命中区，应用内减少动态效果同步覆盖普通 UI。
- **工作现场与工具状态**：阶段和活动保留原有 DOM，按真实调用更新；工具准备记录与正式调用保持同一活动身份。工具状态图标使用连续淡入淡出，避免重建列表反复播放入场动画；移除工作现场重复说明。
- **Time Machine Rich Diff**：新增文件级逐步累计增删统计、旧/新行号、修改行范围、内联增删行、区域跳转及事件/调用关联；保留独立动画重播。二进制、超出比较预算、缺失历史快照均明确降级，不伪造统计。
- **固定历史快照**：Native 与 Bridge 保存修改后的 `after_blob`，回滚或外部编辑不会改写历史 Diff；旧记录必须通过 `after_rev` 核对，否则返回 `HISTORY_UNAVAILABLE`。Native 无实际变化的写入不再新增修改节点。
- **验证故事线纠正**：只用同一命令与工作目录关联失败和通过；区分无修改重试、修改后通过、通过后又修改或撤销。故事节点可跳回对应事件，不把其他命令的成功冒充修复。
- **文档与版本**：Web 包版本同步到 1.0.0；新增产品打磨记录、RC 验收清单与 1.x 路线，更新 README、状态、能力审计和 Runtime API。Native haptic 仍在后续路线中，本轮未接入。

- **统一 UI Motion System**：新增 70/160/240/320/360ms 全局 motion tokens，统一按钮按压、Switch、抽屉、Bottom Sheet、Dialog、Toast、页面切换、聊天/工具卡、工作现场与 Time Machine 的进入/退出节奏；浮层卸载时序同步动画并尊重 reduced-motion。Diffusion 代码编辑动画保持独立。
- **修复 Stable Build Web 回归**：修正设置页版本测试误用未定义 `$` 选择器导致的唯一 Web CI 红项。

- **新增「工作现场」**：顶部状态胶囊现在可点击，打开实时 Agent 工作视图；会展示当前目标、Agent 状态、最近工具调用、正在处理的文件以及每一步的执行状态，不再只能从聊天卡片推断 AI 正在做什么。 工作现场即使当前没有活动任务，也可以进入完整时光机任务列表，不再出现按钮可点但无响应。
- **新增真实任务脉络**：工作现场会根据实际工具活动自动整理「理解目标 → 探索项目 → 执行修改 → 验证结果 → 完成」；未发生的阶段明确标为「未经过」，不会用模型自述伪装成已经执行的步骤。 即使 Agent 直接进入修改或验证，也不会再把此前从未发生的探索/修改阶段误标为已完成。
- **Time Machine 开始接入真实验证节点**：Native Agent 现在会把 `shell_run` 的成功/失败、退出码和末尾输出记录为任务时间线节点，并把 `web_fetch` 纳入真实探索记录；补齐此前 Bridge 有记录而 Native 主路径缺失的验证历史。 时间线 UI 同时明确区分探索、修改、验证失败、验证通过和完成节点，展示关联文件路径与验证输出，并改善手机长路径布局。 修改节点进一步显示创建/写入/修改/删除等真实动作和文件名，已回退节点有明确标记；单步回退文案改为“恢复到这一步之前”，并明确冲突时只会连带移除同一文件的后续修改。\n- **新增项目记忆**：每个项目可维护 `.koide/PROJECT_MEMORY.md`。内容由用户显式编辑和保存，Native 与 Bridge Agent 都会在后续任务中读取；不会把聊天内容偷偷写入长期记忆。 读取或创建失败时会区分“文件不存在”和真实的权限/SAF/冲突错误，避免把访问失败误报成尚未创建。
- **Time Machine Tool Call 精确关联**：Native 与 Bridge 会把真实工具调用的 `call_id` 写入 read/edit/web_fetch/shell_run checkpoint；时间线可显示调用关联，并自动识别「验证失败 → 修改 → 再次验证通过」闭环。旧任务缺少 `call_id` 时继续兼容显示。
- **项目记忆冲突保护**：编辑 `.koide/PROJECT_MEMORY.md` 期间如果文件被外部程序修改，保存会明确提示 revision 冲突并保留编辑框中的未保存内容；新增「重新载入」操作，覆盖本地草稿前会再次确认。
- **设置页版本号改为 Runtime 单一来源**：设置页不再手写 `0.x` 版本字符串，而是直接读取 Native Core / Bridge 的 `hello.version`，避免应用已经升级但「关于/高级」区域仍显示旧版本。
- **修复 Drawer / Bottom Sheet 标题区域异色色块**：普通 Light/Dark 主题下，Sheet 使用 `--surface-1`，旧标题层却混入 `--surface` 并单独做 backdrop-filter，因此标题到关闭按钮区域会出现一整块偏灰/偏黑矩形；OLED 因两层都为纯黑而看不出。现已取消 Sheet 标题独立着色，让标题与主体 surface 连续。
- **1.0 开发线建立**：正式开发分支为 `dev/1.0.0`；0.9.0 的 `main` / `v0.9.0` 保持稳定发布基准。

## 0.9.0（2026-09-26）

- **Koide 正式转正**：应用从 `0.8.0-alpha.7` 升级到 `0.9.0`，移除当前版本的 alpha 标记；Native、Web、Bridge、Cargo、Tauri 与 CodeMirror workspace 包版本统一为 0.9.0。
- **Native Core 成为正式主路径**：Windows / Android 本地应用直接使用 Tauri + Rust Native Core；Python Bridge 调整为浏览器 / LAN 兼容模式，不再作为本地启动前置条件。
- **发布流程转正**：删除 Alpha5/Alpha7 专用工作流与 handoff snapshot；Windows / Android / Web / Rust / Bridge 兼容门禁统一到正式构建工作流，`main` 全绿后创建 `v<version>` 正式 Release，不再追加 `build.N` 或 `--prerelease`。
- **Koide 品牌收口**：设置页、包描述、Agent 身份、Android SAF 插件、权限描述与发行文件名统一使用 Koide；内部 `diffusion-*` 标识仅在兼容历史数据或内部包名处保留。
- **启动链稳定化**：修复设置模块括号错误和欢迎页错误导出引用；Web 资源改为可移植相对路径，CodeMirror 使用模块相对 URL；退役会返回旧启动代码的 Service Worker 缓存。
- **启动诊断可自包含**：启动失败页直接显示错误位置、错误内容、stack、URL 与 User-Agent，并可复制诊断信息。
- **移动端交互完成一轮收口**：AI 抽屉支持半屏、自由高度与向上 fling 全屏；输入栏改为半透明可收束形态，模型入口移入左下角；设置顶栏和移动布局继续使用 Web/CSS 实现。
- **Android SAF 纳入正式能力**：系统目录选择、持久授权、原地文件 I/O、revision/conflict、search/glob、Checkpoint/Trash、recent 与 Export 均进入 Native 主链；SAF workspace 会明确禁用依赖普通 cwd 的 Git / Terminal。
- **已知平台限制继续显式保留**：Android 暂无交互式 PTY；Native LAN Remote Runtime 尚未实现，跨设备访问继续使用可选 Python Bridge；Provider 在同步网络读取被服务端长时间阻塞时，停止可能存在延迟。
- **文档重构**：删除 alpha 交接文档、阶段构建报告与迁移状态清单；README、Native 架构、构建、Runtime API、SAF 与能力审计改为描述 0.9.0 当前事实。
- **回归验证**：本轮本地 Web/UI 回归 71/71、Bridge 兼容回归 47/47 通过；正式发布工作流继续负责 Rust、Windows 与 Android 门禁。

## 0.8.0-alpha.7（预发布历史）

- **修复欢迎页残留导出导致的整页启动失败**：欢迎页仍引用已更名的 `demoKoide`，ES Module 在实例化阶段因此直接中止；现已改为实际存在的 `demoDiffusion`，主界面 UI 启动链恢复。
- **退役会返回旧启动代码的 Service Worker 缓存**：旧版固定使用 `dfx-shell-v0.1.0` 并采用 stale-while-revalidate，可能在新部署或更新后继续先返回旧 HTML/JS。Koide 现在停止注册该 Worker，并在启动前主动注销旧 Worker、清理旧缓存；保留的 `sw.js` 仅用于让已经安装旧 Worker 的浏览器完成一次自清理与刷新。

- **修复 Koide Web 冷启动灰屏**：修正设置页模块中缺失的右括号；该语法错误会在 ES Module 解析阶段阻断整个主界面，即使从未打开设置页也会导致 Web、静态部署与 Android WebView 无法启动。
- **启动失败诊断可直接使用**：启动故障页现在直接显示错误位置、错误信息、堆栈、当前 URL 与 User-Agent，并提供「复制诊断信息」按钮，不再要求用户自行寻找浏览器控制台。

- **移动端 AI 抽屉重做**：进入项目默认关闭，点击 AI 以半屏打开；之后可以连续自由拖动高度，向下越过阈值关闭，拉到顶部进入全屏。全屏背景保持 edge-to-edge，但标题、拖动条和交互内容使用 `safe-area-inset-top` 给 Android/iOS 状态栏让位。
- **文件树实时同步与创建流程收口**：Native watcher 同时跟踪文件与目录并缩短轮询间隔；AI、用户、终端或外部程序造成的变化都会刷新目录树。侧栏只保留一个「+」，统一弹出「你想要创建...?」对话框，可选择取消 / 文件 / 文件夹，并按当前选择确定创建位置。
- **AI 编辑跟随**：新增默认开启的「跟随 AI 编辑」设置；Agent 创建或修改文件后，编辑器实时打开对应文件、展开文件树、定位到变化位置并播放 Diffusion 动画。
- **CodeMirror 6 固定为正式编辑器**：移除运行时内核切换和 textarea 静默回退；Tauri dev/build 与 Bridge 启动脚本会先生成 CM6 产物，加载失败直接显示明确错误。
- **模型菜单与设置清理**：修复非 DeepSeek 模型菜单把 JavaScript `null` 渲染成文字的问题，并为缺失名称提供 model/id 回退；非 DeepSeek 会关闭过期的联网搜索状态。设置页移除「切换全屏」按钮，底层窗口全屏能力不受影响。
- **Native 功能等价门禁正式建立**：新增 `docs/NATIVE_PARITY_AUDIT.md` 与 Runtime dispatch parity CI。Runtime API 共 72 个业务方法，当前已达到 72 / 72 Native dispatch 覆盖；其中 `devices.pair_code` 仍是明确的 `LAN_OFF` 语义缺口，因此 dispatch 全覆盖不等于 Python 删除线完成。只要以后漏掉 Runtime 路由，CI 会直接失败。
- **Android SAF 原地 WorkspaceBackend 已进入源码**：新增不会被 `tauri android init` 覆盖的 Tauri Android SAF 插件，使用 `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission` + `DocumentsContract` 原地读写用户授权目录；Rust Workspace 抽象同时支持 LocalFS / SAF，覆盖 tree/read/write/patch/create/delete/rename/copy、revision/conflict、search/glob、事务式大文件写入、Checkpoint、Diffusion-managed Trash、ZIP Export 与项目 `AGENTS.md`。SAF recent 保存 tree URI；Git / Terminal 对 content URI 显式 capability=false。当前提交仍需 Android CI 与真实设备 smoke 后才算最终门禁通过。
- **四种 Native Agent 模式已齐**：chat / read / edit / agent 均进入 Rust。Edit 写入链为 HardPolicy → PermissionEngine → 审批 → Checkpoint → mutation；支持 ask_user、fs_glob、fs_multi_read、shell_run、terminal_read、web_fetch，以及工具次数/运行时间/修复次数限制。
- **PermissionEngine 已迁入 Rust**：restricted / manual / ai / autonomous、逐工具 deny / ask / session / always / ai_review、allow/deny wildcard、approval_profile、AI reviewer 与失败回退 ASK_USER 均已接入；HardPolicy 始终优先。
- **Aimo 宪法与 Instructions 原生化**：内置宪法、全局 instructions、项目 `AGENTS.md` 真正进入 Native Agent 上下文；recent / permissions / approval_profile 均由 Native settings 持久化。
- **Git 全量接线**：status、diff、stage、unstage、discard、reset、commit、branches、checkout、log、blame、pull、push、init 已接入 NativeCore；破坏性恢复继续经过 Workspace / Trash 安全层。
- **Terminal / Process / Ports 已迁入本地 Native 主链**：Windows PTY、命令运行/取消、交互终端事件、history 与 ports 已接入；Android 支持一次性 shell 命令，交互 PTY 当前明确返回 NO_PTY，不伪装支持。
- **Export 与外部 Watcher 已迁入 Rust**：ZIP Export、真实磁盘变化监听与 `fs.external` 生命周期已经接通。
- **Provider Streaming 大幅推进**：OpenAI-compatible SSE、reasoning delta、MiniMax `<think>` 分离、streamed tool-call 聚合已经通过 Windows / Android CI；服务端长时间沉默时的 blocking read 仍缺真正 hard-cancel。Anthropic / Gemini 的完整流式等价仍需最终核验。
- **Native-only 测试门禁已经跑通**：Alpha7 Run #61 已通过 Native-only Rust tests、Windows x64 EXE、Android ARM64 APK 与 APK 签名验证；Run #66 又通过 Runtime dispatch parity gate。
- **Remote Devices 只迁了存储层，不伪造 LAN server**：device token hashing / revoke 等 Rust 基础已存在，但 Rust Remote Runtime server 与一次性配对码尚未完成，因此远程连接仍不能作为“已迁完”。
- **当前真正硬缺口**：Android SAF 的 CI / 真实设备最终验证；Android interactive PTY；Rust Remote Runtime / pairing；Provider 沉默连接 hard-cancel 与全协议最终等价；最终 Native-only/UI/实机回归。
- **版本策略不变**：以上硬缺口和已知 bug 全部收口前继续保持 alpha，且不删除 Python Bridge。

## 0.8.0-alpha.4
- **Native 服务商配置开始真正接通**：Rust Native Core 新增 profiles.list / save / delete / models / test；Native hello 不再返回空的 profiles / presets，设置页可显示 OpenAI、DeepSeek、Kimi、OpenRouter、Gemini、Anthropic、Ollama、MiniMax 与自定义 OpenAI 兼容接口。
- **模型列表与连接测试走本机 Rust HTTP**：不再依赖 Python Bridge 或 localhost WebSocket；API 密钥保存在应用私有数据目录，前端只看到 has_key。
- **修复移动端网页感缩放**：Native 壳禁止双指页面缩放，并补齐 viewport / touch gesture 限制。
- **GitHub Actions 直接从源码树构建**：Android 与 Windows 均由仓库源码自动构建，不再上传源码 ZIP，也不再手工搬 Gradle/Maven 缓存。
- **自动 prerelease**：Android + Windows 都成功后自动创建 GitHub prerelease，并附加 APK、portable EXE 与 NSIS 安装包。
- **Android 成品签名门禁**：alpha 阶段改为可直接安装的 debug-signed APK，并在发布前强制执行 apksigner verify；未签名 APK 不再进入 Release。
- **版本策略**：Native Agent、Permissions、Git、Terminal、Android SAF 等迁移完成并清理已知问题之前，继续停留在 alpha。

## 0.8.0-alpha.3
- **首次真实 Native 编译通过**：使用完整 Cargo vendor 后，`cargo check --offline --locked --target aarch64-linux-android` 成功；Native Core 已通过 Android ARM64 类型检查。
- **修复 Rust 编译错误**：修正 Trash / Checkpoint / Workspace 的错误映射闭包生命周期，并清理移除 `uuid` 后遗漏的一处临时文件名生成。
- **Android 工程生成成功**：使用 Tauri CLI 2.11.5 的原生 N-API 包直接运行 `tauri android init --skip-targets-install`，成功生成 `src-tauri/gen/android`。
- **Android native `.so` 实际构建成功**：`tauri android build --debug --target aarch64 --apk` 已完成 Rust 编译并生成 `libdiffusion_native_lib.so`；最终 APK 组装目前只被 Gradle 8.14.3 / Maven 离线依赖阻塞。
- **Windows 构建前置修复**：从现有 512×512 PNG 生成标准多尺寸 `icons/icon.ico`；Windows MSVC `cargo check` 现已越过图标错误，下一阻塞精确到宿主机缺 `llvm-rc`。
- **依赖可复现**：引入实际解析出的 `Cargo.lock`；Native npm CLI 版本固定为 `@tauri-apps/cli 2.11.5`。
- **回归验证**：旧行为回归仍为 113/113 全绿。

## 0.8.0-alpha.2
- **Phase C 文件核心继续迁移**：Rust 新增 Patch、Diffusion Trash、Checkpoint/Time Machine 基础、事务式大文件写入。
- **删除恢复语义恢复**：Native `fs.delete` 不再返回 `MIGRATION_PENDING`，所有删除先进入 Rust Trash；恢复会再次验证 Workspace 边界。
- **离线依赖面收缩**：移除 Native Core 对 `hex`、`sha2`、`uuid`、`walkdir`、`windows-sys` 的直接依赖，自带 SHA-256 与标准库递归搜索/ID/Windows 原子替换 FFI。
- **工具链已落地**：Rust 1.98.1、Android ARM64 target、Windows MSVC target、Android SDK 36、Build Tools 36、NDK r27d、cargo-xwin 均已验证可识别。
- **构建阻塞已精确定位**：`cargo check --offline` 目前首先缺 `serde` crate 源码；下一步需要 Cargo vendor，而不是继续补主工具链。
- **验证**：旧行为回归仍为 113/113；`cargo fmt --check` 通过；内置 SHA-256 通过标准向量测试。

## 0.8.0-alpha.1
- **Native Core 重构正式开始**：新增 `apps/native/`，采用 Tauri 2 + Rust；最终目标是完全移除 Python Bridge。
- **UI 与 Bridge 解耦**：新增平台无关 Runtime API；产品组件不再直接调用 `bridge.rpc(...)` / `Bridge.pair(...)`。旧 Bridge 被隔离到 `BridgeRuntimeAdapter`，仅用于迁移期兼容和回归验证。
- **Native Runtime Adapter**：本机模式通过 Tauri IPC 与 `diffusion://event` 直接连接 Rust Core，不走 localhost、8765 或 WebSocket。
- **Rust Workspace 第一批迁移**：已实现工作区打开/关闭/浏览，文件读取、Revision、文件树、搜索、写入、创建、重命名和复制；写入保留 base-revision 冲突检测，并做 symlink 越界检查。
- **破坏性操作不抢跑**：Rust 回收站完成前，原生 `fs.delete` 明确返回 `MIGRATION_PENDING`，不会为了凑功能直接永久删除。
- **文档**：新增 Native Core SPEC、迁移状态、Runtime API 和原生构建说明。
- **验证**：原 v0.7 回归套件仍通过；新增 3 项 Runtime API 测试。当前执行环境缺少 Rust/Cargo、Android SDK/NDK 和 Windows 构建工具链，因此本 alpha 源码未在本环境编译，也没有伪造 EXE/APK。

## 0.7.0
- **输入框重做**：模型名称移进了输入框卡片本身（不再是旁边一个独立按钮），点击后弹出一个悬浮在输入框上方的菜单（不是模态对话框），可以选模型、开关思考、(DeepSeek 时)开关联网搜索、压缩上下文；开关思考不会像之前那样一点就把菜单关掉。输入框本身改成了更高的圆角卡片，半透明磨砂玻璃质感，不再是不透明的实底背景。
- **DeepSeek 联网搜索（尽力而为）**：模型选择 DeepSeek 时，弹出菜单里可以开关"联网搜索"。说明：DeepSeek 官方在稳定的 `/v1/chat/completions` 接口上还没有正式公开、文档化这个能力，这里按目前已知的调用方式接了上去；如果 DeepSeek 后端拒绝或报错，会直接把错误显示出来，此时把开关关掉即可，不影响其他功能。
- **四段式模式开关加了滑动动画**：只能点，不能拖（拖拽中途状态没法对应到一个确定的模式，所以没做拖动）。
- **任务中断后可以直接继续**：不管是被手动停止、出错还是被判定为"可能没做完"，对话里都会出现一个「继续」按钮，点了会带着完整历史继续跑，不用重新描述一遍任务。
- **修复"明明什么都没做却显示任务已完成"**：模型一轮里如果没有调用任何工具就把整个任务标记为"完成"，现在改成标成"任务可能未完成"，并给出继续按钮，而不是当作成功收尾。
- **修复 Gemini 报 `thought_signature` 缺失的 400 错误**：之前把工具调用里除了 id/名字/参数之外的字段都丢弃了，现在原样保留并在下一轮请求里带回去，不管 Google 把这个签名放在字段的哪一层。
- **上下文改成不限制，支持手动压缩**：对话历史不再被悄悄截断到最近 16 条/4000 字；改为可以在输入框上方菜单里点「压缩上下文」，二次确认后用当前模型把这段对话总结成一份结构化摘要，之后的任务只会把摘要发给模型，原文仍完整保留在界面里、以灰色显示，压缩点会有一条分割线标出来。
- **工具调用次数改成不限**：`max_tool_calls` 可以设成 0 表示不限（默认已经是 0），仍然可以随时手动停止。
- **加强了每个工具的说明和系统提示词**：`fs_patch`/`fs_write`/`fs_read`/`shell_run`/`web_fetch` 等工具描述里都补了具体调用示例和常见错误提醒（尤其是 `fs_patch` 反复强调必须逐字匹配、失败了要重新读文件而不是死循环重试）；系统提示词新增了"行动而非叙述"的强约束和明确的能力边界说明，目标是缓解较弱的模型（比如 MiniMax）经常不调用工具、或者调用失败很多次也不知道改思路的问题。
- **`ask_user` 支持一次问多轮**：一次调用可以带多个问题，界面上是一张卡片依次回答，回答完只生成一条摘要，不会一个问题一张卡片。
- **隐藏了设置里的"Aimo 宪法"选项**；**修复了编辑器查找替换按钮第二次点击不关闭、反而聚焦输入框的问题**。
- 版本号升到 0.7.0。

## 0.6.0
- **系统提示词加强（不涉及 Aimo 宪法）**：新增「行动而非叙述」的强约束——模型描述要做某件事，必须在同一轮里真的调用对应工具；没有工具调用结果，就不允许说"已完成/已修复"。目的是修复任务偶尔在没有真正执行任何工具的情况下就被标记为"成功"结束的问题。
- **MiniMax 服务商接入**：新增国际站（`api.minimax.io`）与中国大陆站（`api.minimaxi.com`）两个独立的服务商类型，可分别保存密钥。同时开启 `reasoning_split`，让思考内容进入独立的思考流，而不是把 `<think>…</think>` 原样混进回复文字里。
- **思考内容通用兜底解析**：即使某个 OpenAI 兼容服务商没有正确拆分思考内容，Bridge 也会在流式阶段自动识别 `<think>…</think>` 并转成思考事件，避免思考过程原样出现在聊天气泡里。
- **修复工具状态图标被挤成竖条**：定位到 `.spinner` 用在 `<span>` 上时，`width/height` 在内联元素上不生效，导致执行中的圆形状态图标变形成一条竖线；桌面端和移动端都已修复。
- **修复设置页在手机上挤成一坨**：设置行原本不允许换行，遇到较宽的控件（例如主题的四段选择器）会挤出容器；现在允许在需要时把控件换到下一行。
- **执行状态只显示工具的人类可读名称**：`Tool` 增加独立的 `display_name` 字段，状态卡片和"准备中"提示不会再退化成显示内部的工具 id（例如 `fs_patch`）。
- **新增工具**：`fs_glob`（按文件名 / 通配符查找，不用整体搜索文本）、`fs_multi_read`（一次读取多个文件，减少往返）、`web_fetch`（读取一个网页的正文，带本机 / 内网地址防护）。
- **OLED 模式隐藏主题色设置**：切换到 OLED 纯黑主题后，「主题色」这一行会直接从设置页里消失（因为 OLED 模式本来就不使用主题色染色）。
- **验证**：本版本改动后重新跑通全部既有自动化测试（47 项 Bridge / Python、40 项 Web / 编辑器、23 项界面集成），未新增专门测试用例。

## 0.5.0
- **Aimo 宪法**：内置并完整注入 13 条 Aimo 行为原则，设置页可查看全文；运行时不会为了讨好、维持气氛或显得有能力而编造事实，并保留对不确定性、隐藏前提与用户自主性的要求。
- **输入控件统一**：全局文本输入、命令行输入、新建文件夹、搜索、设置表单等只保留自身一层边框；移除焦点泛光与浏览器叠加焦点环。`textarea` 只能纵向调整大小、不会拖出容器，并为 Chromium / Android 重绘了更克制的拖拽把手。
- **真正的深色 / OLED**：普通深色主题改为中性深灰表面，主题色只承担强调角色；OLED 使用纯黑与中性灰层级，不读取主题色染色。
- **Git 回退体验**：提交历史可直接“回退到这里”，支持软回退与明确确认后的强制回退。强制回退不直接执行 `git reset --hard`，会通过工作区安全层恢复目标版本，并把将被覆盖 / 删除的内容送入 Diffusion 回收站。
- **思考与工具流**：模型思考过程默认展开；原生 Tool Call 参数还在流式到达时就持续更新人类可读的准备状态，只展示路径、命令、问题等必要信息，不把底层 JSON 结构暴露到聊天界面。
- **模型提问工具**：新增原生 `ask_user` 工具。模型可以在任务中提出问题、给出选项或接受自定义回答，任务会暂停等待用户回答后继续。
- **Markdown 工作流**：工作区里的 `.md` / `.markdown` 文件增加“编辑 / 预览”切换，复用安全 Markdown 渲染器，不使用不受控 `innerHTML`。
- **跨位置文件夹选择**：目录选择器允许一路返回上级；Windows 从盘符根目录继续返回会进入盘符列表，POSIX / Android 从 `/` 继续返回会进入位置列表，可再进入主目录、共享存储等可用位置。
- **测试隔离与回归保护**：新增 Aimo 宪法、提问工具、Git 回退、跨盘目录、Markdown 预览、输入框单描边 / OLED 主题等回归测试。
- **验证**：本版本打包前通过 110 项自动化测试（47 项 Bridge / Python、40 项 Web / 编辑器、23 项界面集成）。

## 0.4.0
- **桌面 IDE 布局控制**：顶栏可分别隐藏 / 重新打开左侧工作区、右侧 AI 面板和底部终端；AI 面板本身也提供明确的关闭按钮。
- **移动端编辑体验**：修复编辑器方向键底栏遮挡 AI 输入框；文件编辑支持手势缩放；工具调用卡片可点击展开；全局隐藏滚动条。
- **AI 面板与对话历史**：历史页和底部 Sheet 增加显式关闭 / 返回入口；聊天智能体按钮不再因空间不足强制换行；恢复历史后的工具卡片仍可展开查看。
- **工具调用实时状态**：服务商一开始发出原生 Tool Call 就立即显示“准备中”卡片，参数完整后原地更新为审批、执行和完成状态，不再等到文件修改后才出现。
- **模型与服务商**：服务商配置支持自动获取模型列表并直接选择；智能体加入思考模式“自动 / 开启 / 关闭”，针对 OpenAI 兼容、Anthropic 与 Gemini 的能力差异做兼容降级。
- **运行与渲染**：智能体运行时长支持 `0 = 无限制`；AI 消息 Markdown 扩展支持 ATX / Setext 标题、表格、任务列表、引用、删除线、围栏与缩进代码块等常用语法。
- **文件与项目管理**：项目可从主页或文件面板菜单移除（仅移除最近记录，不删除磁盘文件）；文件树可选择显示 `.git` 等隐藏文件。
- **界面修复**：修复输入框双描边、查找 / 替换区域文字被挤成两行、终端状态刷新反复抢焦点，以及手势监听销毁导致的分屏回归。
- **验证**：本版本打包前通过 105 项自动化测试（40 项 Web / 编辑器、20 项界面集成、45 项 Bridge / Python）。

## 0.3.0
- **扫码配对**：电脑上显示二维码，手机扫码后自动完成配对（纯 JS 二维码编码器，已用 OpenCV 的真实解码器验证）。
- **分屏编辑**：左右或上下两个窗格，同一文件在两个窗格里输入会实时同步；AI 的修改在两个窗格里都播放动画。
- **缩略图**：内置编辑器右侧可选的文件缩略图，点击或拖动快速跳转（设置里开关，手机默认关）。
- **返回首页**：顶部栏新增「首页」按钮（项目里和草稿本里都有）；有未保存修改时会先确认。
- **可以关闭 AI 面板**：面板里有关闭按钮，顶部栏有开关；需要你审批时会自动重新弹出。
- 修复：AI 工具卡片会被压成一条线（聊天区 flex 收缩）。
- 修复：Git 面板和时光机在某些情况下会显示游离的「0」或「null」文字。
- 修复：终端窗口尺寸算不出来时把 NaN 发给后端；Git 面板在只有新文件时找不到「全部暂存」。
- 新增界面交互测试：Git 面板、终端、对话历史、导入、分屏、缩略图、扫码配对、返回首页、AI 面板开关；并加入样式与类名回归检查。

## 0.2.0
- 项目改用 **pnpm 工作区**组织（apps/*、packages/*）。
- 新增 `packages/editor-cm6`：可选的 CodeMirror 6 适配器（折叠、按语言补全、多语言高亮），界面可在运行时热切换；需 `pnpm build:cm6`。
- 模型接口：新增 Anthropic 原生与 Gemini 原生适配器。
- 新增 Git 面板（改动、差异、暂存、提交、分支、拉取推送、日志、逐行追溯）与文件树 Git 角标。
- 新增真正的 PTY 终端（多标签、ANSI 颜色、快捷键行、端口列表）；智能体可读取终端输出（不记录按键）。
- 新增导入 / 导出（事务式分块上传、zip 下载）；文件树支持拖放与「移动到…」。
- 编辑器：查找替换、括号 / 引号自动补全（走 beforeinput，适配安卓输入法）、括号匹配、词语补全。
- 会话历史（多对话、任务间延续上下文）、全局指令、按路径与命令的权限规则。
- 修复：渲染器的影子副本类名与样式表不一致；从第一个匹配处「查找上一个」不会绕回；聊天最后一段回复可能丢失。
## 0.1.0（第一个可运行版本，界面与文档为中文）
- Python 桥接服务（仅标准库）：HTTP + WebSocket 服务，Host/Origin 校验，局域网配对与可撤销的设备令牌。
- 工作区：沙箱文件系统、带版本检查的修改、事务式大文件写入、回收站、搜索、轮询式文件监听。
- 硬性安全规则 + 权限模式（严格 / 手动 / AI 审批 / 自主）+ 逐工具设置 + 审批模型。
- 模型接口：完整的流式 OpenAI 兼容适配器（OpenAI、DeepSeek、Kimi、OpenRouter、Gemini 兼容端点、Ollama、自定义）。
- 智能体：多步工具循环、次数与时间限制、停止、审批、任务检查点、时光机（重播 / 撤销单步 / 单文件 / 整个任务）。
- Diffusion 引擎：块、行、词元三级对应关系，置信度门控与动画预算；声明式动画包。
- 网页界面（无需构建）：MD3 风格主题、横竖屏与宽屏自适应布局、可吸附的 AI 底部面板、抽屉、文件树、标签页、
  带工具卡片和内联审批的聊天、设置页、PWA 外壳。
- 全部界面与文档为简体中文。已知缺口见 docs/STATUS.md。
