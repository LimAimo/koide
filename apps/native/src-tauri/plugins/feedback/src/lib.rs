use serde_json::{json, Value};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

pub struct Feedback<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Feedback<R> {
    pub fn emit(&self, kind: &str) -> Result<Value, String> {
        if !matches!(kind, "snap" | "confirm" | "complete" | "restore") {
            return Err("不支持的触觉类型".into());
        }
        #[cfg(target_os = "android")]
        {
            self.handle.run_mobile_plugin("emit", json!({"kind": kind}))
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        Ok(json!({"supported": false, "performed": false, "reason": "unsupported"}))
    }
}

pub trait FeedbackExt<R: Runtime> {
    fn feedback(&self) -> tauri::State<'_, Feedback<R>>;
}

impl<R: Runtime, T: Manager<R>> FeedbackExt<R> for T {
    fn feedback(&self) -> tauri::State<'_, Feedback<R>> {
        self.state::<Feedback<R>>()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("feedback")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api.register_android_plugin("io.koide.feedback", "FeedbackPlugin")?;
            app.manage(Feedback {
                #[cfg(target_os = "android")]
                handle,
                #[cfg(not(target_os = "android"))]
                _marker: std::marker::PhantomData::<fn() -> R>,
            });
            Ok(())
        })
        .build()
}
