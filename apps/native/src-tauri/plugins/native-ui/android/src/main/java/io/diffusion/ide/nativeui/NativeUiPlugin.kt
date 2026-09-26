package io.diffusion.ide.nativeui

import android.app.Activity
import android.graphics.Color
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class ShellStateArgs {
  var title: String = "Koide"
  var model: String = ""
  var hasWorkspace: Boolean = false
  var agentRunning: Boolean = false
}

data class ShellState(val title:String="Koide", val model:String="", val hasWorkspace:Boolean=false, val agentRunning:Boolean=false)

@TauriPlugin
class NativeUiPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var toolbar: ComposeView? = null
  private var state by mutableStateOf(ShellState())

  override fun load(webView: WebView) {
    // Keep Tauri's WebView startup path untouched. The web app explicitly asks
    // for the native shell only after its first UI tree has been mounted.
    this.webView = webView
  }

  @Command
  fun ready(invoke: Invoke) {
    val web = webView
    if (web == null) {
      invoke.reject("WebView 尚未就绪")
      return
    }
    activity.runOnUiThread {
      try {
        install(web)
        invoke.resolve(JSObject().apply { put("ok", true) })
      } catch (ex: Exception) {
        invoke.reject(ex.message ?: "无法启动 Koide 原生界面")
      }
    }
  }

  @Command
  fun setState(invoke: Invoke) {
    val a = invoke.parseArgs(ShellStateArgs::class.java)
    activity.runOnUiThread { state = ShellState(a.title, a.model, a.hasWorkspace, a.agentRunning) }
    invoke.resolve(JSObject().apply { put("ok", true) })
  }

  private fun install(web: WebView) {
    val root = web.parent as? FrameLayout ?: throw IllegalStateException("Tauri WebView 根容器不支持原生 Shell")
    WindowCompat.setDecorFitsSystemWindows(activity.window, false)
    activity.window.statusBarColor = Color.TRANSPARENT
    activity.window.navigationBarColor = Color.TRANSPARENT
    toolbar?.let(root::removeView)
    toolbar = ComposeView(activity).apply {
      setContent { KoideTheme { BottomDock(state, ::dispatch) } }
    }
    root.addView(toolbar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(88)).apply {
      gravity = android.view.Gravity.BOTTOM
    })
    dispatch("ready", mapOf("bottom" to 88))
  }

  private fun dispatch(action:String, extra:Map<String,Any> = emptyMap()) {
    val payload = JSONObject(extra + ("action" to action)).toString()
    webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('koide:native-ui',{detail:$payload}))", null) }
  }
  private fun dp(v:Int)= (v * activity.resources.displayMetrics.density).toInt()
}

@Composable
private fun KoideTheme(content:@Composable ()->Unit) {
  val scheme = if (android.os.Build.VERSION.SDK_INT >= 31) {
    if (androidx.compose.foundation.isSystemInDarkTheme()) dynamicDarkColorScheme(androidx.compose.ui.platform.LocalContext.current)
    else dynamicLightColorScheme(androidx.compose.ui.platform.LocalContext.current)
  } else if (androidx.compose.foundation.isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
  MaterialTheme(colorScheme=scheme, shapes=Shapes(
    small=RoundedCornerShape(12.dp), medium=RoundedCornerShape(20.dp), large=RoundedCornerShape(30.dp)
  ), content=content)
}

@Composable
private fun BottomDock(s:ShellState, send:(String)->Unit) {
  Box(Modifier.fillMaxSize().padding(horizontal=12.dp, vertical=10.dp)) {
    Surface(Modifier.fillMaxWidth(), shape=RoundedCornerShape(32.dp), tonalElevation=3.dp) {
      Row(Modifier.height(64.dp).padding(6.dp), horizontalArrangement=Arrangement.SpaceEvenly) {
        MorphButton("文件", s.hasWorkspace) { send("files") }
        MorphButton(if(s.agentRunning) "AI · 工作中" else "AI", true) { send("ai") }
        MorphButton("设置", true) { send("settings") }
      }
    }
  }
}

@Composable
private fun RowScope.MorphButton(text:String, enabled:Boolean, onClick:()->Unit) {
  val interaction = remember { MutableInteractionSource() }
  val pressed by interaction.collectIsPressedAsState()
  val scale by animateFloatAsState(if(pressed) .96f else 1f, spring(dampingRatio=.72f, stiffness=520f), label="press")
  val shape = if(pressed) RoundedCornerShape(12.dp) else RoundedCornerShape(28.dp)
  Button(onClick=onClick, enabled=enabled, interactionSource=interaction, shape=shape,
    modifier=Modifier.weight(1f).fillMaxHeight().padding(horizontal=3.dp).scale(scale),
    contentPadding=PaddingValues(horizontal=8.dp)) { Text(text) }
}
