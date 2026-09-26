use serde_json::{json, Value};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.diffusion.ide.nativeui";

pub struct NativeUi<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> NativeUi<R> {
    #[cfg(target_os = "android")]
    pub fn set_state(&self, payload: Value) -> Result<Value, String> {
        self.handle.run_mobile_plugin("setState", payload).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    pub fn set_state(&self, _payload: Value) -> Result<Value, String> {
        Ok(json!({"native": false}))
    }
}
pub trait NativeUiExt<R: Runtime> { fn native_ui(&self) -> tauri::State<'_, NativeUi<R>>; }
impl<R: Runtime, T: Manager<R>> NativeUiExt<R> for T {
    fn native_ui(&self) -> tauri::State<'_, NativeUi<R>> { self.state::<NativeUi<R>>() }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("native-ui").setup(|app, api| {
        #[cfg(target_os = "android")]
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "NativeUiPlugin")?;
        app.manage(NativeUi {
            #[cfg(target_os = "android")] handle,
            #[cfg(not(target_os = "android"))] _marker: std::marker::PhantomData::<fn() -> R>,
        });
        Ok(())
    }).build()
}
