use serde_json::{json, Value};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.diffusion.ide.saf";

pub struct Saf<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Saf<R> {
    #[cfg(target_os = "android")]
    fn call(&self, command: &str, payload: Value) -> Result<Value, String> {
        self.handle
            .run_mobile_plugin(command, payload)
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "android"))]
    fn call(&self, _command: &str, _payload: Value) -> Result<Value, String> {
        Err("SAF 只在 Android 上可用".into())
    }

    pub fn pick_tree(&self) -> Result<Value, String> {
        self.call("pickTree", json!({}))
    }

    pub fn stat(&self, tree_uri: &str, path: &str) -> Result<Value, String> {
        self.call("stat", json!({"treeUri": tree_uri, "path": path}))
    }

    pub fn list(&self, tree_uri: &str, path: &str) -> Result<Value, String> {
        self.call("list", json!({"treeUri": tree_uri, "path": path}))
    }

    pub fn read(&self, tree_uri: &str, path: &str) -> Result<Value, String> {
        self.call("read", json!({"treeUri": tree_uri, "path": path}))
    }

    pub fn write(&self, tree_uri: &str, path: &str, data_b64: &str) -> Result<Value, String> {
        self.call(
            "write",
            json!({"treeUri": tree_uri, "path": path, "data": data_b64}),
        )
    }

    pub fn create(&self, tree_uri: &str, path: &str, kind: &str) -> Result<Value, String> {
        self.call(
            "create",
            json!({"treeUri": tree_uri, "path": path, "kind": kind}),
        )
    }

    pub fn delete(&self, tree_uri: &str, path: &str) -> Result<Value, String> {
        self.call("delete", json!({"treeUri": tree_uri, "path": path}))
    }

    pub fn rename(&self, tree_uri: &str, from: &str, to: &str) -> Result<Value, String> {
        self.call(
            "rename",
            json!({"treeUri": tree_uri, "from": from, "to": to}),
        )
    }

    pub fn copy(&self, tree_uri: &str, from: &str, to: &str) -> Result<Value, String> {
        self.call(
            "copy",
            json!({"treeUri": tree_uri, "from": from, "to": to}),
        )
    }
}

pub trait SafExt<R: Runtime> {
    fn saf(&self) -> tauri::State<'_, Saf<R>>;
}

impl<R: Runtime, T: Manager<R>> SafExt<R> for T {
    fn saf(&self) -> tauri::State<'_, Saf<R>> {
        self.state::<Saf<R>>()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("saf")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SafPlugin")?;
            app.manage(Saf {
                #[cfg(target_os = "android")]
                handle,
                #[cfg(not(target_os = "android"))]
                _marker: std::marker::PhantomData::<fn() -> R>,
            });
            Ok(())
        })
        .build()
}
