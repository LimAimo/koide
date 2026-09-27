package io.koide.feedback

import android.app.Activity
import android.os.Build
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class FeedbackArgs {
    var kind: String = ""
}

@TauriPlugin
class FeedbackPlugin(private val activity: Activity) : Plugin(activity) {
    private var lastFeedbackAt = -1000L

    @Command
    fun emit(invoke: Invoke) {
        try {
            val kind = invoke.parseArgs(FeedbackArgs::class.java).kind
            val effect = when (kind) {
                "snap" -> if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK
                "confirm", "complete", "restore" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK
                else -> { invoke.reject("不支持的触觉类型"); return }
            }
            val requestedAt = SystemClock.uptimeMillis()
            activity.runOnUiThread {
                try {
                    val view = activity.window.decorView
                    val now = SystemClock.uptimeMillis()
                    val reason = when {
                        activity.isFinishing || !view.isShown || !view.hasWindowFocus() -> "background"
                        now - requestedAt > 250 -> "expired"
                        now - lastFeedbackAt < 120 -> "throttled"
                        else -> null
                    }
                    var performed = false
                    if (reason == null) {
                        lastFeedbackAt = now
                        // 不使用忽略系统/视图设置的标志，不申请振动权限。
                        performed = view.performHapticFeedback(effect)
                    }
                    invoke.resolve(JSObject().apply {
                        put("supported", true)
                        put("performed", performed)
                        put("reason", reason ?: if (performed) "performed" else "system_or_device")
                    })
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "无法提供触觉反馈")
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "触觉参数无效")
        }
    }
}
