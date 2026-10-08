#![recursion_limit = "512"]

mod core;

use core::{NativeCore, RuntimeError};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

struct AppState {
    core: Arc<Mutex<NativeCore>>,
    stop_agent: Arc<dyn Fn() -> Result<Value, RuntimeError> + Send + Sync>,
}


#[tauri::command]
async fn runtime_call(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, RuntimeError> {
    // 停止标志不等待截图/模型检查持有的 Core 锁；不开放其他绕过领域边界的操作。
    if method == "agent.stop" { return (state.stop_agent)(); }
    let shared = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut core = shared.lock().map_err(|_| RuntimeError::new("LOCK_POISONED", "Native Core 状态锁已损坏"))?;
        core.call(&app, &method, params)
    }).await.map_err(|e| RuntimeError::new("RUNTIME_JOIN_FAILED", format!("运行时任务未能完成：{e}")))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(diffusion_saf::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let core = NativeCore::new(data_dir);
            let stop_agent = core.stop_handle();
            app.manage(AppState { core: Arc::new(Mutex::new(core)), stop_agent });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![runtime_call])
        .run(tauri::generate_context!())
        .expect("Diffusion Native failed to start");
}
