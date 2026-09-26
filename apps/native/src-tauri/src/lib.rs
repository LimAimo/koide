#![recursion_limit = "512"]

mod core;

use core::{NativeCore, RuntimeError};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use koide_native_ui::NativeUiExt;

struct AppState(Mutex<NativeCore>);

#[tauri::command]
fn native_ui_ready(app: AppHandle) -> Result<Value, RuntimeError> {
    app.native_ui().ready().map_err(|e| RuntimeError::new("NATIVE_UI", e))
}

#[tauri::command]
fn native_ui_state(app: AppHandle, payload: Value) -> Result<Value, RuntimeError> {
    app.native_ui().set_state(payload).map_err(|e| RuntimeError::new("NATIVE_UI", e))
}

#[tauri::command]
fn runtime_call(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, RuntimeError> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| RuntimeError::new("LOCK_POISONED", "Native Core 状态锁已损坏"))?;
    core.call(&app, &method, params)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(diffusion_saf::init())
        .plugin(koide_native_ui::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState(Mutex::new(NativeCore::new(data_dir))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![runtime_call, native_ui_ready, native_ui_state])
        .run(tauri::generate_context!())
        .expect("Diffusion Native failed to start");
}
