# 声音与触觉

自 1.0.0-rc.2 接入。设置位于「声音与触觉」：Android 原生触觉默认开启并遵循系统设置；完成提示音默认关闭。两者独立于 Diffusion 动画与减少动态效果开关。

| 真实事件 | 触觉 | 提示音 |
|---|---|---|
| AI 面板拖动释放后吸附半屏/全屏，或手势关闭 | 一次轻反馈；弹簧中断则不补发 | 无 |
| 用户点危险操作的确认按钮 | 确认反馈 | 无 |
| `agent.done` 明确携带 `status=done` 与任务 ID | 每项任务最多一次 | 开启后播放短完成提示 |
| Checkpoint 或回收站恢复成功 | 成功反馈 | 开启后播放短恢复提示 |
| 普通点击、工具消息、自由高度释放、停止/失败/未完成任务 | 无 | 无 |

## 实现与边界

- Android 走 `Runtime API → Rust → koide-feedback Kotlin plugin`。SAF 插件继续只负责文件原语；没有新增 Agent 工具或虚构历史节点。
- `View.performHapticFeedback` 使用系统效果，不传入忽略用户设置的标志。Android 34+ 吸附使用 `SEGMENT_TICK`；旧系统使用 `CLOCK_TICK`。确认/成功在 Android 30+ 使用 `CONFIRM`，旧系统使用 `CONTEXT_CLICK`。
- 握手 capability 只说明通路可用。系统设置、设备硬件或视图状态可能让实际反馈返回 false；不把它显示成操作失败，也不宣称已经振动。
- 前端对反馈限频 120ms，对完成任务保留最近 64 个去重标识；后台事件直接丢弃，回到前台不补播。Android 再检查前台窗口、120ms 间隔与主线程排队 250ms 超时。
- Windows 与 Bridge 明确返回不支持原生触觉。不会请求远端电脑振动，也不调用浏览器 `navigator.vibrate` 充数。
- 提示音由 Web Audio 在本机生成，无外部音效资源。仅启用后通过真实用户交互解锁音频；音频不可用/未解锁时静默降级，不缓存以后补播。隐藏页面挂起音频、关闭开关释放音频上下文；受设备媒体音量影响，不是系统通知。
- 设置的「体验完成反馈」使用相同开关和降级逻辑。反馈失败不阻塞编辑、确认、任务结束或恢复。

## 验证状态

新增 Web 回归覆盖能力降级、用户开关、去重、后台抑制、限频与原生调用失败；Bridge 覆盖不支持和非法类型。按用户要求不运行本地测试，构建与回归交由本提交的 CI。具体设备触感、系统设置和音量行为仍待 Android 真机验收。

参考：[Android 触觉 API](https://developer.android.com/develop/ui/views/haptics/haptics-apis)、[系统语义效果](https://developer.android.com/reference/android/view/HapticFeedbackConstants)、[Tauri 移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/)。
