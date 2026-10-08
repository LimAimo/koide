use super::{
    checkpoint::CheckpointStore, crypto::sha256_hex, id::unique_id, settings::wildcard_match, trash::Trash, RuntimeError,
};
use serde_json::{json, Value};
use diffusion_saf::SafExt;
use tauri::AppHandle;
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EVENT_TEXT: usize = 512 * 1024;
const TMP_PREFIX: &str = ".koide-tmp-";
const EXPORT_MAX_TOTAL: u64 = 300 * 1024 * 1024;
const EXPORT_SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".gradle", ".idea",
];

pub fn browse_location(path: Option<&str>, _app_data_dir: Option<&Path>) -> Result<Value, RuntimeError> {
    if path.is_none() || path == Some("__locations__") {
        let mut entries = Vec::new();
        #[cfg(windows)]
        {
            for letter in b'A'..=b'Z' {
                let drive = format!("{}:\\\\", letter as char);
                if Path::new(&drive).is_dir() {
                    entries.push(json!({"name": drive.clone(), "path": drive}));
                }
            }
        }
        #[cfg(target_os = "android")]
        {
            if let Some(data_dir) = _app_data_dir {
                let workspaces = data_dir.join("workspaces");
                fs::create_dir_all(&workspaces)
                    .map_err(io_err("READ_FAILED", &workspaces.to_string_lossy()))?;
                entries.push(json!({
                    "name": "Koide 私有工作区",
                    "path": workspaces.to_string_lossy()
                }));
            }

            // Some devices expose Downloads as a normal readable directory; only advertise it
            // when the app can actually enumerate it. Android scoped storage usually blocks this,
            // so SAF remains the proper route for arbitrary shared folders.
            for candidate in ["/storage/emulated/0/Download", "/sdcard/Download"] {
                let p = PathBuf::from(candidate);
                if p.is_dir() && fs::read_dir(&p).is_ok() {
                    entries.push(json!({"name": "下载", "path": p.to_string_lossy()}));
                    break;
                }
            }
        }
        #[cfg(all(not(windows), not(target_os = "android")))]
        {
            if let Some(home) = std::env::var_os("HOME") {
                let home = PathBuf::from(home);
                if home.is_dir() {
                    entries.push(json!({"name": "主目录", "path": home.to_string_lossy()}));
                }
            }
            let root = PathBuf::from("/");
            if root.is_dir() {
                entries.push(json!({"name": "/", "path": "/"}));
            }
        }
        return Ok(
            json!({"virtual": true, "path": "位置", "parent": null, "entries": entries, "is_project": false}),
        );
    }

    let raw = path.unwrap();
    let p = PathBuf::from(raw);
    let real = fs::canonicalize(&p).map_err(io_err("NOT_A_FOLDER", raw))?;
    if !real.is_dir() {
        return Err(RuntimeError::new(
            "NOT_A_FOLDER",
            format!("{raw} 不是文件夹"),
        ));
    }
    let mut entries = fs::read_dir(&real).map_err(io_err("READ_FAILED", raw))?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| json!({"name": e.file_name().to_string_lossy(), "path": e.path().to_string_lossy()}))
        .collect::<Vec<_>>();
    entries.sort_by_key(|v| {
        v.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
    });
    let markers = [
        ".git",
        "package.json",
        "pyproject.toml",
        "build.gradle",
        "pom.xml",
        "Cargo.toml",
        "go.mod",
    ];
    let is_project = markers.iter().any(|m| real.join(m).exists());
    let parent = real
        .parent()
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_else(|| "__locations__".into());
    Ok(
        json!({"virtual": false, "path": real.to_string_lossy(), "parent": parent, "entries": entries, "is_project": is_project}),
    )
}

pub struct Mutation {
    pub changed: bool,
    pub result: Value,
    pub event: Value,
}

pub struct BatchMutation {
    pub result: Value,
    pub events: Vec<Value>,
}

struct PendingWrite {
    target: PathBuf,
    temp: PathBuf,
    next_seq: usize,
    bytes: usize,
    base_revision: Option<String>,
}


#[derive(Clone)]
pub struct Workspace {
    backend: std::sync::Arc<std::sync::Mutex<WorkspaceBackend>>,
}

enum WorkspaceBackend {
    Local(LocalWorkspace),
    Saf(SafWorkspace),
}

impl Workspace {
    pub fn open(path: &str, data_dir: &Path) -> Result<Self, RuntimeError> {
        Ok(Self {
            backend: std::sync::Arc::new(std::sync::Mutex::new(WorkspaceBackend::Local(
                LocalWorkspace::open(path, data_dir)?,
            ))),
        })
    }

    pub fn open_location(app: &AppHandle, location: &Value, data_dir: &Path) -> Result<Self, RuntimeError> {
        if let Some(path) = location.as_str() {
            return Self::open(path, data_dir);
        }
        let obj = location.as_object().ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "工作区位置必须是路径或位置对象"))?;
        match obj.get("kind").and_then(Value::as_str).unwrap_or("local") {
            "local" => {
                let path = obj.get("path").and_then(Value::as_str)
                    .ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "本地工作区缺少 path"))?;
                Self::open(path, data_dir)
            }
            "saf" => {
                let uri = obj.get("uri").and_then(Value::as_str)
                    .ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "SAF 工作区缺少 uri"))?;
                let name = obj.get("name").and_then(Value::as_str).unwrap_or("project");
                Ok(Self {
                    backend: std::sync::Arc::new(std::sync::Mutex::new(WorkspaceBackend::Saf(
                        SafWorkspace::open(app.clone(), uri, name, data_dir)?,
                    ))),
                })
            }
            other => Err(RuntimeError::new("BAD_WORKSPACE", format!("未知工作区类型：{other}"))),
        }
    }

    pub fn pick_saf(app: &AppHandle) -> Result<Value, RuntimeError> {
        #[cfg(target_os = "android")]
        {
            let picked = app.saf().pick_tree().map_err(|e| RuntimeError::new("SAF_PICK_FAILED", e))?;
            let uri = picked.get("uri").and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::new("SAF_PICK_FAILED", "系统没有返回目录 URI"))?;
            let name = picked.get("name").and_then(Value::as_str).unwrap_or("project");
            return Ok(json!({"kind":"saf","uri":uri,"name":name}));
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Err(RuntimeError::new("UNSUPPORTED_PLATFORM", "SAF 目录选择器只在 Android 上可用"))
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, WorkspaceBackend>, RuntimeError> {
        self.backend.lock().map_err(|_| RuntimeError::new("LOCK_POISONED", "工作区状态锁已损坏"))
    }

    pub fn info(&self) -> Value { match &*self.lock().expect("workspace lock") { WorkspaceBackend::Local(x) => x.info(), WorkspaceBackend::Saf(x) => x.info() } }
    pub fn location(&self) -> Value { match &*self.lock().expect("workspace lock") { WorkspaceBackend::Local(x) => json!({"kind":"local","path":x.root_path().to_string_lossy(),"name":x.info()["name"]}), WorkspaceBackend::Saf(x) => x.location() } }
    pub fn terminal_directory(&self, raw: &str) -> Result<PathBuf, RuntimeError> {
        match &*self.lock()? {
            WorkspaceBackend::Local(x) => {
                let path = if raw == "." || raw.is_empty() { x.root_path() } else { x.resolve_existing(raw)? };
                if !path.is_dir() { return Err(RuntimeError::new("NOT_A_FOLDER", "命令工作目录不是文件夹")); }
                Ok(path)
            }
            WorkspaceBackend::Saf(_) => Err(RuntimeError::new("WORKSPACE_CAPABILITY", "SAF 项目不能作为系统命令工作目录")),
        }
    }
    pub fn is_saf(&self) -> bool { matches!(&*self.lock().expect("workspace lock"), WorkspaceBackend::Saf(_)) }
    pub fn local_root_path(&self) -> Option<PathBuf> { match &*self.lock().ok()? { WorkspaceBackend::Local(x) => Some(x.root_path()), WorkspaceBackend::Saf(_) => None } }
    pub fn storage_key(&self) -> String { match &*self.lock().expect("workspace lock") { WorkspaceBackend::Local(x) => x.storage_key(), WorkspaceBackend::Saf(x) => x.storage_key() } }
    pub(crate) fn checkpoint_handle(&self) -> CheckpointStore { match &*self.lock().expect("workspace lock") { WorkspaceBackend::Local(x) => x.checkpoint_handle(), WorkspaceBackend::Saf(x) => x.checkpoint_handle() } }
    pub fn supports_git(&self) -> bool { !self.is_saf() }
    pub fn supports_terminal_cwd(&self) -> bool { !self.is_saf() }
    pub fn project_instructions(&self) -> String {
        match self.read("AGENTS.md") {
            Ok(v) if v.get("binary").and_then(Value::as_bool) != Some(true) => v.get("content").and_then(Value::as_str).unwrap_or("").chars().take(8000).collect(),
            _ => String::new(),
        }
    }

    pub fn read(&self, raw:&str)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.read(raw),WorkspaceBackend::Saf(x)=>x.read(raw)}}
    pub fn hash(&self, raw:&str)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.hash(raw),WorkspaceBackend::Saf(x)=>x.hash(raw)}}
    pub fn tree(&self, raw:&str, depth:usize, show_hidden:bool)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.tree(raw,depth,show_hidden),WorkspaceBackend::Saf(x)=>x.tree(raw,depth,show_hidden)}}
    pub fn glob(&self,p:&str,max:usize)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.glob(p,max),WorkspaceBackend::Saf(x)=>x.glob(p,max)}}
    pub fn search(&self,q:&str,cs:bool,max:usize)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.search(q,cs,max),WorkspaceBackend::Saf(x)=>x.search(q,cs,max)}}
    pub fn write_text(&self,p:&str,c:&str,b:Option<&str>)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.write_text(p,c,b),WorkspaceBackend::Saf(x)=>x.write_text(p,c,b)}}
    pub(crate) fn write_bytes_protected(&self,p:&str,d:&[u8],b:Option<&str>)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.write_bytes_protected(p,d,b),WorkspaceBackend::Saf(x)=>x.write_bytes_protected(p,d,b)}}
    pub(crate) fn set_executable_protected(&self,p:&str,e:bool)->Result<(),RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.set_executable_protected(p,e),WorkspaceBackend::Saf(x)=>x.set_executable_protected(p,e)}}
    pub fn begin_write(&self,p:&str,b:Option<&str>)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.begin_write(p,b),WorkspaceBackend::Saf(x)=>x.begin_write(p,b)}}
    pub fn write_chunk(&self,id:&str,seq:usize,d:&str,e:&str)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.write_chunk(id,seq,d,e),WorkspaceBackend::Saf(x)=>x.write_chunk(id,seq,d,e)}}
    pub fn commit_write(&self,id:&str,total:usize,sha:&str)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.commit_write(id,total,sha),WorkspaceBackend::Saf(x)=>x.commit_write(id,total,sha)}}
    pub fn abort_write(&self,id:&str)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.abort_write(id),WorkspaceBackend::Saf(x)=>x.abort_write(id)}}
    pub fn create(&self,p:&str,k:&str,c:&str)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.create(p,k,c),WorkspaceBackend::Saf(x)=>x.create(p,k,c)}}
    pub fn patch(&self,p:&str,b:&str,e:&[Value])->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.patch(p,b,e),WorkspaceBackend::Saf(x)=>x.patch(p,b,e)}}
    pub fn delete(&self,p:&str)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.delete(p),WorkspaceBackend::Saf(x)=>x.delete(p)}}
    pub fn delete_if_revision(&self, p: &str, base: &str) -> Result<Mutation, RuntimeError> {
        let backend = self.lock()?;
        let current = match &*backend { WorkspaceBackend::Local(x) => x.hash(p)?, WorkspaceBackend::Saf(x) => x.hash(p)? };
        if current["revision"].as_str() != Some(base) { return Err(RuntimeError::new("REVISION_CONFLICT", "删除前文件已变化").with_data(json!({"path":p,"current_revision":current["revision"]}))); }
        match &*backend { WorkspaceBackend::Local(x) => x.delete(p), WorkspaceBackend::Saf(x) => x.delete(p) }
    }
    pub fn apply_text_edits(&self, files: &[Value], label: &str) -> Result<(Value, Vec<Value>), RuntimeError> {
        if files.is_empty() || files.len() > 200 { return Err(RuntimeError::new("BAD_EDIT", "批量修改需要 1 到 200 个文件")); }
        let backend = self.lock()?;
        let cp = match &*backend { WorkspaceBackend::Local(x) => x.checkpoint_handle(), WorkspaceBackend::Saf(x) => x.checkpoint_handle() };
        let mut checked = Vec::new();
        let mut paths = std::collections::HashSet::new();
        let mut resolved_paths = std::collections::HashSet::new();
        for f in files {
            let p = f["path"].as_str().ok_or_else(||RuntimeError::new("BAD_EDIT","缺少文件路径"))?;
            super::policy::check_write_path(p)?;
            if !paths.insert(p) { return Err(RuntimeError::new("BAD_EDIT","批量修改包含重复路径")); }
            let revision = f["revision"].as_str().ok_or_else(||RuntimeError::new("BAD_EDIT","缺少基础 revision"))?;
            let content = f["content"].as_str().ok_or_else(||RuntimeError::new("BAD_EDIT","缺少文件内容"))?;
            if content.len() > MAX_READ_BYTES as usize { return Err(RuntimeError::new("TOO_LARGE","重命名文件超过大小上限")); }
            let before = match &*backend { WorkspaceBackend::Local(x)=>x.read(p)?,WorkspaceBackend::Saf(x)=>x.read(p)? };
            let canonical = before["path"].as_str().unwrap_or(p);
            super::policy::check_write_path(canonical)?;
            if !resolved_paths.insert(canonical.to_owned()) { return Err(RuntimeError::new("BAD_EDIT","批量修改的多个路径指向同一文件")); }
            if before["revision"].as_str() != Some(revision) { return Err(RuntimeError::new("REVISION_CONFLICT","批量修改的基础版本已过期").with_data(json!({"path":p}))); }
            if before["binary"].as_bool().unwrap_or(false) { return Err(RuntimeError::new("BAD_EDIT","不能对二进制文件执行语言重命名")); }
            checked.push((p.to_owned(),revision.to_owned(),content.to_owned(),before["content"].as_str().unwrap_or("").to_owned()));
        }
        let task = cp.start_task(label,"edit")?;
        let id = task["id"].as_str().unwrap_or_default();
        let mut events = Vec::new();
        for (p,revision,content,before) in checked {
            cp.record_before(id,&p,Some(before.as_bytes()))?;
            let mutation = match &*backend {WorkspaceBackend::Local(x)=>x.write_text(&p,&content,Some(&revision)),WorkspaceBackend::Saf(x)=>x.write_text(&p,&content,Some(&revision))};
            match mutation {
                Ok(m) => { if m.changed { let before_blob = cp.blob_for_event_before(Some(before.as_bytes()))?; cp.add_event(id,"edit",&format!("修改 {p}"),json!({"path":p,"before_blob":before_blob,"before_rev":revision,"after_rev":m.result["revision"]}))?; events.push(m.event); } }
                Err(e) => { cp.finish_task(id,"error",&e.message)?; return Err(e.with_data(json!({"task_id":id,"partial":!events.is_empty(),"recovery":"checkpoint.revert_task"}))); }
            }
        }
        cp.finish_task(id,"done",label)?;
        Ok((json!({"task_id":id,"files":events.len()}),events))
    }
    pub fn trash_list(&self)->Result<Vec<Value>,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.trash_list(),WorkspaceBackend::Saf(x)=>x.trash_list()}}
    pub fn trash_delete(&self,id:&str)->Result<(),RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.trash_delete(id),WorkspaceBackend::Saf(x)=>x.trash_delete(id)}}
    pub fn trash_empty(&self)->Result<usize,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.trash_empty(),WorkspaceBackend::Saf(x)=>x.trash_empty()}}
    pub fn restore_from_trash(&self,id:&str)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.restore_from_trash(id),WorkspaceBackend::Saf(x)=>x.restore_from_trash(id)}}
    pub fn export_zip(&self,p:&str,d:&Path)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.export_zip(p,d),WorkspaceBackend::Saf(x)=>x.export_zip(p,d)}}
    pub fn checkpoint_tasks(&self,l:usize)->Result<Vec<Value>,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.checkpoint_tasks(l),WorkspaceBackend::Saf(x)=>x.checkpoint_tasks(l)}}
    pub fn checkpoint_task(&self,id:&str)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.checkpoint_task(id),WorkspaceBackend::Saf(x)=>x.checkpoint_task(id)}}
    pub fn checkpoint_diff(&self,id:&str,seq:usize)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.checkpoint_diff(id,seq),WorkspaceBackend::Saf(x)=>x.checkpoint_diff(id,seq)}}
    pub fn checkpoint_revert_file(&self,id:&str,p:&str)->Result<BatchMutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.checkpoint_revert_file(id,p),WorkspaceBackend::Saf(x)=>x.checkpoint_revert_file(id,p)}}
    pub fn checkpoint_revert_task(&self,id:&str)->Result<BatchMutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.checkpoint_revert_task(id),WorkspaceBackend::Saf(x)=>x.checkpoint_revert_task(id)}}
    pub fn checkpoint_revert_event(&self,id:&str,seq:usize,force:bool)->Result<BatchMutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.checkpoint_revert_event(id,seq,force),WorkspaceBackend::Saf(x)=>x.checkpoint_revert_event(id,seq,force)}}
    pub fn rename(&self,f:&str,t:&str)->Result<Mutation,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.rename(f,t),WorkspaceBackend::Saf(x)=>x.rename(f,t)}}
    pub fn copy(&self,f:&str,t:&str)->Result<Value,RuntimeError>{match &*self.lock()?{WorkspaceBackend::Local(x)=>x.copy(f,t),WorkspaceBackend::Saf(x)=>x.copy(f,t)}}
}

struct LocalWorkspace {
    root: PathBuf,
    canonical_root: PathBuf,
    trash: Trash,
    checkpoints: CheckpointStore,
    writes: RefCell<HashMap<String, PendingWrite>>,
}

impl LocalWorkspace {
    pub fn open(path: &str, data_dir: &Path) -> Result<Self, RuntimeError> {
        let root = PathBuf::from(path);
        if !root.is_dir() {
            return Err(RuntimeError::new(
                "NOT_A_FOLDER",
                format!("{path} 不是文件夹"),
            ));
        }
        let canonical_root = fs::canonicalize(&root).map_err(io_err("OPEN_FAILED", path))?;
        let canonical_data = fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
        if canonical_root == canonical_data || canonical_root.starts_with(&canonical_data) {
            return Err(RuntimeError::new(
                "SENSITIVE_PATH",
                "不能把 Diffusion 自己的私有数据目录作为项目打开",
            ));
        }
        let workspace_key = sha256_hex(canonical_root.to_string_lossy().as_bytes());
        let workspace_key = &workspace_key[..16];
        let trash = Trash::new(data_dir.join("trash").join(workspace_key))?;
        let checkpoints = CheckpointStore::new(data_dir.join("checkpoints").join(workspace_key))?;
        Ok(Self {
            root: canonical_root.clone(),
            canonical_root,
            trash,
            checkpoints,
            writes: RefCell::new(HashMap::new()),
        })
    }

    pub fn info(&self) -> Value {
        json!({
            "roots": [self.root.to_string_lossy()],
            "name": self.root.file_name().and_then(|x| x.to_str()).unwrap_or("project"),
            "location": {"kind":"local","path":self.root.to_string_lossy()},
            "backend": "local",
            "capabilities": {
                "git": true,
                "terminal_cwd": true,
                "watcher": true,
                "posix_permissions": cfg!(unix)
            }
        })
    }

    pub fn root_path(&self) -> PathBuf {
        self.canonical_root.clone()
    }

    pub(crate) fn checkpoint_handle(&self) -> CheckpointStore {
        self.checkpoints.clone()
    }

    pub fn storage_key(&self) -> String {
        let key = sha256_hex(self.canonical_root.to_string_lossy().as_bytes());
        key[..16].to_owned()
    }

    fn rel_display(&self, p: &Path) -> String {
        p.strip_prefix(&self.canonical_root)
            .ok()
            .map(|x| {
                if x.as_os_str().is_empty() {
                    ".".into()
                } else {
                    x.to_string_lossy().replace('\\', "/")
                }
            })
            .unwrap_or_else(|| p.to_string_lossy().into_owned())
    }

    fn lexical_candidate(&self, raw: &str) -> Result<PathBuf, RuntimeError> {
        if raw.is_empty() || raw.contains('\0') {
            return Err(RuntimeError::new("BAD_PATH", "路径不能为空"));
        }
        let p = Path::new(raw);
        if p.is_absolute() {
            return Err(RuntimeError::new(
                "OUTSIDE_WORKSPACE",
                "Native Core 只接受工作区相对路径",
            ));
        }
        for c in p.components() {
            if matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) {
                return Err(RuntimeError::new(
                    "OUTSIDE_WORKSPACE",
                    format!("{raw} 在工作区之外"),
                ));
            }
        }
        Ok(self.canonical_root.join(p))
    }

    /// Resolve an existing target, following symlinks and rejecting escapes.
    fn resolve_existing(&self, raw: &str) -> Result<PathBuf, RuntimeError> {
        let candidate = self.lexical_candidate(raw)?;
        let real = fs::canonicalize(&candidate).map_err(io_err("NOT_FOUND", raw))?;
        if !real.starts_with(&self.canonical_root) {
            return Err(RuntimeError::new(
                "OUTSIDE_WORKSPACE",
                format!("{raw} 通过符号链接指向了工作区之外"),
            ));
        }
        Ok(real)
    }

    /// Resolve a target that may not exist. Its nearest existing parent is canonicalized so a
    /// symlinked parent can never redirect a create/write outside the workspace.
    fn resolve_for_write(&self, raw: &str) -> Result<PathBuf, RuntimeError> {
        let candidate = self.lexical_candidate(raw)?;
        let mut ancestor = candidate.as_path();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| RuntimeError::new("OUTSIDE_WORKSPACE", "路径没有有效父目录"))?;
        }
        let real_parent = fs::canonicalize(ancestor).map_err(io_err("BAD_PATH", raw))?;
        if !real_parent.starts_with(&self.canonical_root) {
            return Err(RuntimeError::new(
                "OUTSIDE_WORKSPACE",
                format!("{raw} 的父目录通过符号链接指向工作区之外"),
            ));
        }
        // Existing target gets a second canonical check so a final-component symlink is rejected.
        if candidate.exists() {
            return self.resolve_existing(raw);
        }
        Ok(candidate)
    }

    pub fn read(&self, raw: &str) -> Result<Value, RuntimeError> {
        let p = self.resolve_existing(raw)?;
        if !p.is_file() {
            return Err(RuntimeError::new("NOT_FOUND", format!("{raw} 不是文件")));
        }
        let meta = fs::metadata(&p).map_err(io_err("READ_FAILED", raw))?;
        if meta.len() > MAX_READ_BYTES {
            return Err(RuntimeError::new(
                "TOO_LARGE",
                format!("{raw} 超过 8 MiB 读取上限"),
            ));
        }
        let data = fs::read(&p).map_err(io_err("READ_FAILED", raw))?;
        let revision = revision_of(Some(&data));
        match std::str::from_utf8(&data) {
            Ok(text) if !data[..data.len().min(4096)].contains(&0) => Ok(json!({
                "path": self.rel_display(&p), "content": text, "revision": revision, "size": data.len(), "binary": false
            })),
            _ => Ok(
                json!({"path": self.rel_display(&p), "revision": revision, "size": data.len(), "binary": true}),
            ),
        }
    }

    pub fn hash(&self, raw: &str) -> Result<Value, RuntimeError> {
        let candidate = self.lexical_candidate(raw)?;
        if !candidate.exists() {
            return Ok(json!({"path": raw, "revision": revision_of(None)}));
        }
        let p = self.resolve_existing(raw)?;
        let bytes = if p.is_file() {
            Some(fs::read(&p).map_err(io_err("READ_FAILED", raw))?)
        } else {
            None
        };
        Ok(json!({"path": self.rel_display(&p), "revision": revision_of(bytes.as_deref())}))
    }

    pub fn tree(&self, raw: &str, depth: usize, show_hidden: bool) -> Result<Value, RuntimeError> {
        let p = if raw == "." || raw.is_empty() {
            self.canonical_root.clone()
        } else {
            self.resolve_existing(raw)?
        };
        if !p.is_dir() {
            return Err(RuntimeError::new(
                "NOT_A_FOLDER",
                format!("{raw} 不是文件夹"),
            ));
        }
        Ok(Value::Array(self.tree_level(&p, depth, show_hidden)?))
    }

    fn tree_level(
        &self,
        dir: &Path,
        depth: usize,
        show_hidden: bool,
    ) -> Result<Vec<Value>, RuntimeError> {
        let mut children = fs::read_dir(dir)
            .map_err(io_err("READ_FAILED", &dir.to_string_lossy()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        children.sort_by_key(|e| {
            (
                e.file_type().map(|t| !t.is_dir()).unwrap_or(true),
                e.file_name().to_string_lossy().to_lowercase(),
            )
        });
        let mut out = Vec::new();
        for e in children {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(TMP_PREFIX)
                || (!show_hidden && matches!(name.as_str(), ".git" | ".DS_Store"))
            {
                continue;
            }
            let raw_path = e.path();
            let real = match fs::canonicalize(&raw_path) {
                Ok(x) if x.starts_with(&self.canonical_root) => x,
                _ => continue,
            };
            let meta = match fs::metadata(&real) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let mut node = json!({
                "name": name, "path": self.rel_display(&real), "type": if is_dir {"dir"} else {"file"},
                "size": meta.len(),
                "mtime": meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|x| x.as_secs_f64()).unwrap_or(0.0)
            });
            if is_dir && depth > 1 {
                node["children"] = Value::Array(self.tree_level(&real, depth - 1, show_hidden)?);
            }
            out.push(node);
        }
        Ok(out)
    }

    fn glob(&self, pattern: &str, max_results: usize) -> Result<Value, RuntimeError> {
        if pattern.trim().is_empty() { return Err(RuntimeError::new("BAD_QUERY", "glob pattern 不能为空")); }
        let mut paths = Vec::new();
        self.glob_level(&self.canonical_root, pattern, max_results, &mut paths)?;
        Ok(json!({"paths":paths,"truncated":paths.len()>=max_results}))
    }

    fn glob_level(&self, dir: &Path, pattern: &str, max_results: usize, out: &mut Vec<String>) -> Result<(), RuntimeError> {
        if out.len() >= max_results { return Ok(()); }
        let entries = match fs::read_dir(dir) { Ok(x) => x, Err(_) => return Ok(()) };
        for entry in entries.filter_map(Result::ok) {
            if out.len() >= max_results { break; }
            let Ok(ty) = entry.file_type() else { continue; };
            if ty.is_symlink() { continue; }
            let path = entry.path();
            let rel = self.rel_display(&path);
            let name = entry.file_name().to_string_lossy().into_owned();
            if ty.is_dir() && matches!(name.as_str(), ".git"|"node_modules"|"target"|".gradle"|".idea"|"__pycache__"|".venv"|"venv") { continue; }
            if wildcard_match(pattern, &rel) { out.push(rel.clone()); }
            if ty.is_dir() { self.glob_level(&path, pattern, max_results, out)?; }
        }
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        case_sensitive: bool,
        max_results: usize,
    ) -> Result<Value, RuntimeError> {
        if query.is_empty() {
            return Err(RuntimeError::new("BAD_QUERY", "搜索内容不能为空"));
        }
        let needle = if case_sensitive {
            query.to_owned()
        } else {
            query.to_lowercase()
        };
        let mut matches = Vec::new();
        let mut files_scanned = 0usize;
        self.search_dir(
            &self.canonical_root,
            &needle,
            case_sensitive,
            max_results,
            &mut matches,
            &mut files_scanned,
        )?;
        let truncated = matches.len() >= max_results;
        Ok(json!({"matches": matches, "files_scanned": files_scanned, "truncated": truncated}))
    }

    fn search_dir(
        &self,
        dir: &Path,
        needle: &str,
        case_sensitive: bool,
        max_results: usize,
        matches: &mut Vec<Value>,
        files_scanned: &mut usize,
    ) -> Result<(), RuntimeError> {
        let entries = match fs::read_dir(dir) {
            Ok(x) => x,
            Err(_) => return Ok(()),
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if matches!(
                name.as_str(),
                ".git" | "node_modules" | "__pycache__" | ".venv" | "venv" | ".gradle" | ".idea"
            ) {
                continue;
            }
            let Ok(ty) = entry.file_type() else {
                continue;
            };
            if ty.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ty.is_dir() {
                self.search_dir(
                    &path,
                    needle,
                    case_sensitive,
                    max_results,
                    matches,
                    files_scanned,
                )?;
                if matches.len() >= max_results {
                    return Ok(());
                }
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > 1_000_000 {
                continue;
            }
            let Ok(data) = fs::read(&path) else {
                continue;
            };
            if data[..data.len().min(4096)].contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&data);
            *files_scanned += 1;
            for (idx, line) in text.lines().enumerate() {
                let hay = if case_sensitive {
                    line.to_owned()
                } else {
                    line.to_lowercase()
                };
                if let Some(col) = hay.find(needle) {
                    matches.push(json!({
                        "path": self.rel_display(&path), "line": idx + 1, "column": col + 1,
                        "text": line.chars().take(300).collect::<String>()
                    }));
                    if matches.len() >= max_results {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn commit_bytes(
        &self,
        raw: &str,
        p: &Path,
        data: &[u8],
        base_revision: Option<&str>,
    ) -> Result<Mutation, RuntimeError> {
        if p.exists() && !p.is_file() {
            return Err(RuntimeError::new("NOT_A_FILE", format!("{raw} 不是文件")));
        }
        let before = if p.is_file() {
            Some(fs::read(p).map_err(io_err("READ_FAILED", raw))?)
        } else {
            None
        };
        let current = revision_of(before.as_deref());
        if let Some(base) = base_revision {
            if base != current {
                return Err(RuntimeError::new(
                    "CONFLICT",
                    format!("{raw} 在读取之后已被修改，请重新读取后再试"),
                )
                .with_data(json!({"current_revision": current})));
            }
        }
        if before.as_deref() == Some(data) {
            return Ok(Mutation {
                changed: false,
                result: json!({"path": raw, "revision": current, "changed": false}),
                event: json!({}),
            });
        }
        atomic_write(p, data).map_err(io_err("WRITE_FAILED", raw))?;
        let after_rev = revision_of(Some(data));
        let rel = self.rel_display(p);
        let kind = if before.is_some() { "modify" } else { "create" };
        Ok(Mutation {
            changed: true,
            result: json!({"path": rel, "revision": after_rev, "changed": true}),
            event: json!({
                "kind": kind, "path": rel,
                "before_text": event_text(before.as_deref()), "after_text": event_text(Some(data)),
                "before_rev": revision_of(before.as_deref()), "after_rev": after_rev,
                "actor": "user", "task_id": null
            }),
        })
    }

    pub fn write_text(
        &self,
        raw: &str,
        content: &str,
        base_revision: Option<&str>,
    ) -> Result<Mutation, RuntimeError> {
        let p = self.resolve_for_write(raw)?;
        self.commit_bytes(raw, &p, content.as_bytes(), base_revision)
    }

    pub(crate) fn write_bytes_protected(
        &self,
        raw: &str,
        data: &[u8],
        base_revision: Option<&str>,
    ) -> Result<Mutation, RuntimeError> {
        let p = self.resolve_for_write(raw)?;
        self.commit_bytes(raw, &p, data, base_revision)
    }

    pub(crate) fn set_executable_protected(
        &self,
        raw: &str,
        executable: bool,
    ) -> Result<(), RuntimeError> {
        let p = self.resolve_existing(raw)?;
        if !p.is_file() {
            return Err(RuntimeError::new("NOT_A_FILE", format!("{raw} 不是文件")));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::metadata(&p).map_err(io_err("READ_FAILED", raw))?;
            let mut mode = meta.permissions().mode();
            if executable {
                mode |= 0o111;
            } else {
                mode &= !0o111;
            }
            fs::set_permissions(&p, fs::Permissions::from_mode(mode))
                .map_err(io_err("WRITE_FAILED", raw))?;
        }
        #[cfg(not(unix))]
        {
            let _ = executable;
        }
        Ok(())
    }

    pub fn begin_write(
        &self,
        raw: &str,
        base_revision: Option<&str>,
    ) -> Result<Value, RuntimeError> {
        let target = self.resolve_for_write(raw)?;
        let current = if target.is_file() {
            revision_of(Some(
                &fs::read(&target).map_err(io_err("READ_FAILED", raw))?,
            ))
        } else {
            "absent".to_owned()
        };
        if let Some(base) = base_revision {
            if base != current {
                return Err(RuntimeError::new(
                    "CONFLICT",
                    format!("{raw} 在读取之后已被修改，请重新读取后再试"),
                )
                .with_data(json!({"current_revision": current})));
            }
        }
        let parent = target
            .parent()
            .ok_or_else(|| RuntimeError::new("BAD_PATH", "目标没有父目录"))?;
        fs::create_dir_all(parent).map_err(io_err("WRITE_FAILED", raw))?;
        let write_id = unique_id("w");
        let temp = parent.join(format!("{TMP_PREFIX}{write_id}"));
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(io_err("WRITE_FAILED", raw))?;
        self.writes.borrow_mut().insert(
            write_id.clone(),
            PendingWrite {
                target,
                temp,
                next_seq: 0,
                bytes: 0,
                base_revision: base_revision.map(ToOwned::to_owned),
            },
        );
        Ok(json!({"write_id": write_id}))
    }

    pub fn write_chunk(
        &self,
        write_id: &str,
        seq: usize,
        data: &str,
        encoding: &str,
    ) -> Result<Value, RuntimeError> {
        let mut writes = self.writes.borrow_mut();
        let pending = writes
            .get_mut(write_id)
            .ok_or_else(|| RuntimeError::new("NO_SUCH_WRITE", "写入事务不存在或已结束"))?;
        if seq != pending.next_seq {
            let expected = pending.next_seq;
            let temp = pending.temp.clone();
            writes.remove(write_id);
            let _ = fs::remove_file(temp);
            return Err(RuntimeError::new(
                "SEQUENCE_ERROR",
                format!("写入块顺序错误：期望 {expected}，收到 {seq}；写入已中止"),
            ));
        }
        let bytes = match encoding {
            "utf-8" | "utf8" => data.as_bytes().to_vec(),
            "base64" => decode_base64(data)?,
            _ => {
                return Err(RuntimeError::new(
                    "BAD_ENCODING",
                    "分块写入只支持 utf-8 或 base64",
                ))
            }
        };
        let mut file = OpenOptions::new()
            .append(true)
            .open(&pending.temp)
            .map_err(io_err("WRITE_FAILED", write_id))?;
        file.write_all(&bytes)
            .map_err(io_err("WRITE_FAILED", write_id))?;
        pending.bytes += bytes.len();
        pending.next_seq += 1;
        Ok(json!({"received_bytes": pending.bytes, "next_seq": pending.next_seq}))
    }

    pub fn commit_write(
        &self,
        write_id: &str,
        total_bytes: usize,
        expected_sha256: &str,
    ) -> Result<Mutation, RuntimeError> {
        let pending = self
            .writes
            .borrow_mut()
            .remove(write_id)
            .ok_or_else(|| RuntimeError::new("NO_SUCH_WRITE", "写入事务不存在或已结束"))?;
        let result = (|| {
            if pending.bytes != total_bytes {
                return Err(RuntimeError::new(
                    "BYTE_COUNT_MISMATCH",
                    format!("收到 {} 字节，期望 {total_bytes} 字节", pending.bytes),
                ));
            }
            let data = fs::read(&pending.temp).map_err(io_err("READ_FAILED", write_id))?;
            let actual = sha256_hex(&data);
            let expected = expected_sha256
                .strip_prefix("sha256:")
                .unwrap_or(expected_sha256);
            if actual != expected {
                return Err(
                    RuntimeError::new("HASH_MISMATCH", "内容哈希不匹配；原文件未被改动")
                        .with_data(json!({"actual":actual,"expected":expected})),
                );
            }
            let rel = self.rel_display(&pending.target);
            self.commit_bytes(
                &rel,
                &pending.target,
                &data,
                pending.base_revision.as_deref(),
            )
        })();
        let _ = fs::remove_file(&pending.temp);
        result
    }

    pub fn abort_write(&self, write_id: &str) -> Result<Value, RuntimeError> {
        let pending = self.writes.borrow_mut().remove(write_id);
        if let Some(pending) = pending.as_ref() {
            let _ = fs::remove_file(&pending.temp);
        }
        Ok(json!({"aborted": pending.is_some()}))
    }

    pub fn create(&self, raw: &str, kind: &str, content: &str) -> Result<Mutation, RuntimeError> {
        let p = self.resolve_for_write(raw)?;
        if p.exists() {
            return Err(RuntimeError::new("ALREADY_EXISTS", format!("{raw} 已存在")));
        }
        let rel = self.rel_display(&p);
        match kind {
            "dir" | "folder" => {
                fs::create_dir_all(&p).map_err(io_err("CREATE_FAILED", raw))?;
                Ok(Mutation {
                    changed: true,
                    result: json!({"path": rel, "type":"dir"}),
                    event: json!({
                        "kind":"create", "path": rel, "before_text": null, "after_text": null,
                        "before_rev":"absent", "after_rev":"absent", "actor":"user", "task_id":null
                    }),
                })
            }
            "file" => {
                let data = content.as_bytes();
                atomic_write(&p, data).map_err(io_err("CREATE_FAILED", raw))?;
                let revision = revision_of(Some(data));
                Ok(Mutation {
                    changed: true,
                    result: json!({"path": rel, "revision": revision, "changed":true}),
                    event: json!({
                        "kind":"create", "path": rel, "before_text": null, "after_text": event_text(Some(data)),
                        "before_rev":"absent", "after_rev":revision, "actor":"user", "task_id":null
                    }),
                })
            }
            _ => Err(RuntimeError::new("BAD_REQUEST", "kind 只能是 file 或 dir")),
        }
    }

    pub fn patch(
        &self,
        raw: &str,
        base_revision: &str,
        edits: &[Value],
    ) -> Result<Mutation, RuntimeError> {
        if base_revision.is_empty() {
            return Err(RuntimeError::new(
                "NEEDS_REVISION",
                "修改文件需要 base_revision，请先读取该文件",
            ));
        }
        if edits.is_empty() {
            return Err(RuntimeError::new("BAD_EDIT", "edits 必须是非空列表"));
        }
        let p = self.resolve_existing(raw)?;
        if !p.is_file() {
            return Err(RuntimeError::new("NOT_FOUND", format!("{raw} 不存在")));
        }
        let bytes = fs::read(&p).map_err(io_err("READ_FAILED", raw))?;
        let current = revision_of(Some(&bytes));
        if current != base_revision {
            return Err(RuntimeError::new(
                "CONFLICT",
                format!("{raw} 在读取之后已被修改，请重新读取后再试"),
            )
            .with_data(json!({"current_revision": current})));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| RuntimeError::new("BINARY", format!("{raw} 不是 UTF-8 文本")))?;
        let new_text = apply_edits(text, edits)?;
        self.write_text(raw, &new_text, Some(base_revision))
    }

    pub fn delete(&self, raw: &str) -> Result<Mutation, RuntimeError> {
        let p = self.resolve_existing(raw)?;
        if p == self.canonical_root {
            return Err(RuntimeError::new("POLICY_DENIED", "不能删除工作区根目录"));
        }
        let rel = self.rel_display(&p);
        let before = if p.is_file() {
            Some(fs::read(&p).map_err(io_err("READ_FAILED", raw))?)
        } else {
            None
        };
        let trash_id = self.trash.move_in(&p)?;
        Ok(Mutation {
            changed: true,
            result: json!({"path": rel, "trash_id": trash_id}),
            event: json!({
                "kind":"delete", "path":rel, "before_text":event_text(before.as_deref()), "after_text":null,
                "before_rev":revision_of(before.as_deref()), "after_rev":"absent", "actor":"user", "task_id":null
            }),
        })
    }

    pub fn trash_list(&self) -> Result<Vec<Value>, RuntimeError> {
        self.trash.list()
    }
    pub fn trash_delete(&self, id: &str) -> Result<(), RuntimeError> {
        self.trash.delete_permanently(id)
    }
    pub fn trash_empty(&self) -> Result<usize, RuntimeError> {
        self.trash.empty()
    }

    pub fn restore_from_trash(&self, id: &str) -> Result<Mutation, RuntimeError> {
        let dest = self.trash.restore(id, &self.canonical_root)?;
        let rel = self.rel_display(&dest);
        let after = if dest.is_file() {
            Some(fs::read(&dest).map_err(io_err("READ_FAILED", &rel))?)
        } else {
            None
        };
        Ok(Mutation {
            changed: true,
            result: json!({"path": rel}),
            event: json!({
                "kind":"create", "path":rel, "before_text":null, "after_text":event_text(after.as_deref()),
                "before_rev":"absent", "after_rev":revision_of(after.as_deref()), "actor":"system", "task_id":null
            }),
        })
    }

    pub fn export_zip(&self, raw: &str, data_dir: &Path) -> Result<Value, RuntimeError> {
        let target = self.resolve_existing(raw)?;
        let exports = data_dir.join("exports");
        fs::create_dir_all(&exports).map_err(io_err("EXPORT_FAILED", &exports.to_string_lossy()))?;

        if let Ok(items) = fs::read_dir(&exports) {
            for entry in items.flatten() {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) == Some("zip") {
                    let _ = fs::remove_file(path);
                }
            }
        }

        let base = target
            .file_name()
            .and_then(|x| x.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("project");
        let name = format!("{base}.zip");
        let output = exports.join(format!("{}-{}", unique_id("export-"), name));
        let file = File::create(&output).map_err(io_err("EXPORT_FAILED", &output.to_string_lossy()))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut total = 0u64;

        fn add_path(
            zip: &mut zip::ZipWriter<File>,
            source: &Path,
            archive_name: &str,
            options: zip::write::SimpleFileOptions,
            total: &mut u64,
        ) -> Result<(), RuntimeError> {
            let meta = fs::symlink_metadata(source)
                .map_err(io_err("EXPORT_FAILED", &source.to_string_lossy()))?;
            if meta.file_type().is_symlink() {
                return Ok(());
            }
            if meta.is_file() {
                *total = total.saturating_add(meta.len());
                if *total > EXPORT_MAX_TOTAL {
                    return Err(RuntimeError::new(
                        "EXPORT_TOO_LARGE",
                        "内容超过 300 MB，无法一次性导出，请分批导出子文件夹",
                    ));
                }
                zip.start_file(archive_name.replace('\\', "/"), options)
                    .map_err(|e| RuntimeError::new("EXPORT_FAILED", e.to_string()))?;
                let mut input = File::open(source)
                    .map_err(io_err("EXPORT_FAILED", &source.to_string_lossy()))?;
                std::io::copy(&mut input, zip)
                    .map_err(io_err("EXPORT_FAILED", &source.to_string_lossy()))?;
                return Ok(());
            }
            if meta.is_dir() {
                let mut entries = fs::read_dir(source)
                    .map_err(io_err("EXPORT_FAILED", &source.to_string_lossy()))?
                    .filter_map(Result::ok)
                    .collect::<Vec<_>>();
                entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
                for entry in entries {
                    let child = entry.path();
                    let child_name = entry.file_name().to_string_lossy().into_owned();
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                        && EXPORT_SKIP_DIRS.contains(&child_name.as_str())
                    {
                        continue;
                    }
                    if child_name.starts_with(".diffusion-tmp-") {
                        continue;
                    }
                    let dest = if archive_name.is_empty() {
                        child_name
                    } else {
                        format!("{archive_name}/{child_name}")
                    };
                    add_path(zip, &child, &dest, options, total)?;
                }
            }
            Ok(())
        }

        let archive_root = if target.is_file() {
            base.to_owned()
        } else {
            base.to_owned()
        };
        let result = add_path(&mut zip, &target, &archive_root, options, &mut total);
        if let Err(error) = result {
            drop(zip);
            let _ = fs::remove_file(&output);
            return Err(error);
        }
        zip.finish()
            .map_err(|e| RuntimeError::new("EXPORT_FAILED", e.to_string()))?;
        let size = fs::metadata(&output)
            .map_err(io_err("EXPORT_FAILED", &output.to_string_lossy()))?
            .len();
        Ok(json!({
            "native_path": output.to_string_lossy(),
            "name": name,
            "size": size,
            "source_bytes": total
        }))
    }

    pub fn checkpoint_tasks(&self, limit: usize) -> Result<Vec<Value>, RuntimeError> {
        self.checkpoints.list_tasks(limit)
    }
    pub fn checkpoint_task(&self, task_id: &str) -> Result<Value, RuntimeError> {
        self.checkpoints.load(task_id)
    }

    fn restore_checkpoint_state(
        &self,
        rel: &str,
        existed: bool,
        blob: Option<&str>,
    ) -> Result<Option<Value>, RuntimeError> {
        let p = self.resolve_for_write(rel)?;
        let current = if p.is_file() {
            Some(fs::read(&p).map_err(io_err("READ_FAILED", rel))?)
        } else {
            None
        };
        if existed {
            let blob = blob
                .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "Checkpoint 缺少 blob"))?;
            let data = self.checkpoints.get_blob(blob)?;
            if current.as_deref() == Some(data.as_slice()) {
                return Ok(None);
            }
            if p.exists() && !p.is_file() {
                return Err(RuntimeError::new(
                    "NOT_A_FILE",
                    format!("{rel} 当前不是文件"),
                ));
            }
            atomic_write(&p, &data).map_err(io_err("RESTORE_FAILED", rel))?;
            let kind = if current.is_some() {
                "modify"
            } else {
                "create"
            };
            return Ok(Some(json!({
                "kind":kind, "path":rel, "before_text":event_text(current.as_deref()), "after_text":event_text(Some(&data)),
                "before_rev":revision_of(current.as_deref()), "after_rev":revision_of(Some(&data)), "actor":"system", "task_id":null
            })));
        }
        if p.is_file() {
            let before = current.unwrap_or_default();
            self.trash.move_in(&p)?;
            return Ok(Some(json!({
                "kind":"delete", "path":rel, "before_text":event_text(Some(&before)), "after_text":null,
                "before_rev":revision_of(Some(&before)), "after_rev":"absent", "actor":"system", "task_id":null
            })));
        }
        Ok(None)
    }

    pub fn checkpoint_diff(&self, task_id: &str, seq: usize) -> Result<Value, RuntimeError> {
        let task = self.checkpoints.load(task_id)?;
        let events = task["events"]
            .as_array()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "任务 events 无效"))?;
        let event = events
            .get(seq)
            .ok_or_else(|| RuntimeError::new("BAD_EVENT", "Checkpoint 事件编号超出范围"))?;
        if event["type"].as_str() != Some("edit") {
            return Err(RuntimeError::new("NOT_AN_EDIT", "这条记录没有可比较的差异"));
        }
        let rel = event["path"]
            .as_str()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "编辑事件缺少 path"))?;
        let before = event
            .get("before_blob")
            .and_then(Value::as_str)
            .map(|sha| self.checkpoints.get_blob(sha))
            .transpose()?;
        let mut after = None;
        for later in events.iter().skip(seq + 1) {
            if later["type"].as_str() == Some("edit") && later["path"].as_str() == Some(rel) {
                after = later
                    .get("before_blob")
                    .and_then(Value::as_str)
                    .map(|sha| self.checkpoints.get_blob(sha))
                    .transpose()?;
                break;
            }
        }
        if after.is_none() {
            let p = self.resolve_for_write(rel)?;
            if p.is_file() {
                after = Some(fs::read(&p).map_err(io_err("READ_FAILED", rel))?);
            }
        }
        Ok(
            json!({"path":rel, "before":event_text(before.as_deref()), "after":event_text(after.as_deref())}),
        )
    }

    pub fn checkpoint_revert_file(
        &self,
        task_id: &str,
        rel: &str,
    ) -> Result<BatchMutation, RuntimeError> {
        let task = self.checkpoints.load(task_id)?;
        let snap = task["files"].get(rel).ok_or_else(|| {
            RuntimeError::new("NOT_IN_TASK", format!("任务 {task_id} 没有改动过 {rel}"))
        })?;
        let event = self.restore_checkpoint_state(
            rel,
            snap["existed"].as_bool().unwrap_or(false),
            snap.get("blob").and_then(Value::as_str),
        )?;
        Ok(BatchMutation {
            result: json!({"reverted":[rel]}),
            events: event.into_iter().collect(),
        })
    }

    pub fn checkpoint_revert_task(&self, task_id: &str) -> Result<BatchMutation, RuntimeError> {
        let task = self.checkpoints.load(task_id)?;
        let files = task["files"]
            .as_object()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "任务 files 无效"))?;
        let mut reverted = Vec::new();
        let mut emitted = Vec::new();
        for (rel, snap) in files {
            if let Some(event) = self.restore_checkpoint_state(
                rel,
                snap["existed"].as_bool().unwrap_or(false),
                snap.get("blob").and_then(Value::as_str),
            )? {
                emitted.push(event);
            }
            reverted.push(rel.clone());
        }
        let seqs = task["events"]
            .as_array()
            .map(|events| {
                events
                    .iter()
                    .filter(|e| e["type"].as_str() == Some("edit"))
                    .filter_map(|e| e["seq"].as_u64().map(|n| n as usize))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.checkpoints.mark_reverted(task_id, &seqs)?;
        let _ = self.checkpoints.add_event(
            task_id,
            "revert",
            &format!("已将 {} 个文件恢复到任务开始之前", reverted.len()),
            json!({}),
        );
        Ok(BatchMutation {
            result: json!({"reverted":reverted}),
            events: emitted,
        })
    }

    pub fn checkpoint_revert_event(
        &self,
        task_id: &str,
        seq: usize,
        force: bool,
    ) -> Result<BatchMutation, RuntimeError> {
        let task = self.checkpoints.load(task_id)?;
        let event = task["events"]
            .as_array()
            .and_then(|x| x.get(seq))
            .ok_or_else(|| RuntimeError::new("BAD_EVENT", "Checkpoint 事件编号超出范围"))?;
        let kind = event["kind"].as_str().unwrap_or("");
        if event["type"].as_str() != Some("edit") || !matches!(kind, "create" | "modify" | "delete")
        {
            return Err(RuntimeError::new("NOT_REVERTIBLE", "这条记录无法单独撤销"));
        }
        let rel = event["path"]
            .as_str()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "编辑事件缺少 path"))?;
        let p = self.resolve_for_write(rel)?;
        let current = if p.is_file() {
            Some(fs::read(&p).map_err(io_err("READ_FAILED", rel))?)
        } else {
            None
        };
        if !force {
            let expected = event["after_rev"].as_str().unwrap_or("absent");
            let actual = revision_of(current.as_deref());
            if actual != expected {
                return Err(RuntimeError::new(
                    "CONFLICT",
                    format!("{rel} 在这一步之后又被修改过，撤销会丢失后续的工作"),
                )
                .with_data(json!({"current_revision":actual})));
            }
        }
        let restored = self.restore_checkpoint_state(
            rel,
            event["existed_before"].as_bool().unwrap_or(false),
            event.get("before_blob").and_then(Value::as_str),
        )?;
        self.checkpoints.mark_reverted(task_id, &[seq])?;
        Ok(BatchMutation {
            result: json!({"reverted":[rel]}),
            events: restored.into_iter().collect(),
        })
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<Mutation, RuntimeError> {
        let src = self.resolve_existing(from)?;
        let dst = self.resolve_for_write(to)?;
        if dst.exists() {
            return Err(RuntimeError::new("ALREADY_EXISTS", format!("{to} 已存在")));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(io_err("RENAME_FAILED", to))?;
        }
        fs::rename(&src, &dst).map_err(io_err("RENAME_FAILED", from))?;
        let rel = self.rel_display(&dst);
        Ok(Mutation {
            changed: true,
            result: json!({"path": rel}),
            event: json!({
                "kind":"rename", "path":rel, "old_path":from.replace('\\', "/"), "before_text":null, "after_text":null,
                "before_rev":revision_of(None), "after_rev":revision_of(None), "actor":"user", "task_id":null
            }),
        })
    }

    pub fn copy(&self, from: &str, to: &str) -> Result<Value, RuntimeError> {
        let src = self.resolve_existing(from)?;
        let dst = self.resolve_for_write(to)?;
        if dst.exists() {
            return Err(RuntimeError::new("ALREADY_EXISTS", format!("{to} 已存在")));
        }
        if src.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(io_err("COPY_FAILED", to))?;
            }
            fs::copy(&src, &dst).map_err(io_err("COPY_FAILED", from))?;
        }
        Ok(json!({"path": self.rel_display(&dst)}))
    }
}


struct SafPendingWrite {
    path: String,
    temp: PathBuf,
    next_seq: usize,
    bytes: usize,
    base_revision: Option<String>,
}

struct SafWorkspace {
    app: AppHandle,
    uri: String,
    name: String,
    trash: Trash,
    checkpoints: CheckpointStore,
    writes: RefCell<HashMap<String, SafPendingWrite>>,
}

impl SafWorkspace {
    fn open(app: AppHandle, uri: &str, name: &str, data_dir: &Path) -> Result<Self, RuntimeError> {
        if !uri.starts_with("content://") {
            return Err(RuntimeError::new("BAD_WORKSPACE", "SAF 工作区必须使用 content:// tree URI"));
        }
        let stat = app.saf().stat(uri, ".").map_err(|e| RuntimeError::new("SAF_PERMISSION", format!("无法访问已授权目录：{e}")))?;
        if stat.get("exists").and_then(Value::as_bool) != Some(true)
            || stat.get("type").and_then(Value::as_str) != Some("dir")
        {
            return Err(RuntimeError::new("SAF_PERMISSION", "已保存的 Android 目录授权已失效，请重新选择目录"));
        }
        let key = sha256_hex(uri.as_bytes());
        let key = &key[..16];
        Ok(Self {
            app,
            uri: uri.to_owned(),
            name: if name.trim().is_empty() { "project".into() } else { name.to_owned() },
            trash: Trash::new(data_dir.join("trash").join(key))?,
            checkpoints: CheckpointStore::new(data_dir.join("checkpoints").join(key))?,
            writes: RefCell::new(HashMap::new()),
        })
    }

    fn info(&self) -> Value {
        json!({
            "roots": [self.uri],
            "name": self.name,
            "location": self.location(),
            "backend": "saf",
            "capabilities": {
                "git": false,
                "terminal_cwd": false,
                "watcher": "refresh",
                "posix_permissions": false
            }
        })
    }

    fn location(&self) -> Value {
        json!({"kind":"saf","uri":self.uri,"name":self.name})
    }

    fn storage_key(&self) -> String {
        sha256_hex(self.uri.as_bytes())[..16].to_owned()
    }

    fn checkpoint_handle(&self) -> CheckpointStore { self.checkpoints.clone() }

    fn clean_rel(raw: &str) -> Result<String, RuntimeError> {
        if raw.contains('\0') {
            return Err(RuntimeError::new("BAD_PATH", "路径包含无效字符"));
        }
        let normalized = raw.replace('\\', "/");
        let normalized = normalized.trim_matches('/');
        if normalized.is_empty() || normalized == "." {
            return Ok(".".into());
        }
        if raw.starts_with('/') || raw.starts_with('\\') {
            return Err(RuntimeError::new("OUTSIDE_WORKSPACE", "只接受工作区相对路径"));
        }
        let mut parts = Vec::new();
        for part in normalized.split('/') {
            if part.is_empty() || part == "." || part == ".." {
                return Err(RuntimeError::new("OUTSIDE_WORKSPACE", "路径试图离开工作区"));
            }
            parts.push(part);
        }
        Ok(parts.join("/"))
    }

    fn stat(&self, raw: &str) -> Result<Value, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        self.app.saf().stat(&self.uri, &rel)
            .map_err(|e| RuntimeError::new("SAF_IO", format!("{rel}: {e}")))
    }

    fn exists(&self, raw: &str) -> Result<bool, RuntimeError> {
        Ok(self.stat(raw)?.get("exists").and_then(Value::as_bool) == Some(true))
    }

    fn list_entries(&self, raw: &str) -> Result<Vec<Value>, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let value = self.app.saf().list(&self.uri, &rel)
            .map_err(|e| RuntimeError::new("READ_FAILED", format!("{rel}: {e}")))?;
        Ok(value.get("entries").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    fn read_bytes(&self, raw: &str) -> Result<Vec<u8>, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let stat = self.stat(&rel)?;
        if stat.get("exists").and_then(Value::as_bool) != Some(true) {
            return Err(RuntimeError::new("NOT_FOUND", format!("{rel} 不存在")));
        }
        if stat.get("type").and_then(Value::as_str) != Some("file") {
            return Err(RuntimeError::new("NOT_A_FILE", format!("{rel} 不是文件")));
        }
        if stat.get("size").and_then(Value::as_u64).unwrap_or(0) > MAX_READ_BYTES {
            return Err(RuntimeError::new("TOO_LARGE", format!("{rel} 超过 8 MiB 读取上限")));
        }
        self.read_bytes_unbounded(&rel)
    }

    fn read_bytes_unbounded(&self, raw: &str) -> Result<Vec<u8>, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let value = self.app.saf().read(&self.uri, &rel)
            .map_err(|e| RuntimeError::new("READ_FAILED", format!("{rel}: {e}")))?;
        let encoded = value.get("data").and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::new("READ_FAILED", format!("{rel}: SAF 返回缺少 data")))?;
        decode_base64(encoded)
    }

    fn ensure_parent_dirs(&self, raw: &str) -> Result<(), RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        if let Some((parent, _)) = rel.rsplit_once('/') {
            if !self.exists(parent)? {
                self.app.saf().create(&self.uri, parent, "dir")
                    .map_err(|e| RuntimeError::new("CREATE_FAILED", format!("{parent}: {e}")))?;
            }
        }
        Ok(())
    }

    fn write_raw(&self, raw: &str, data: &[u8]) -> Result<(), RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        if rel == "." { return Err(RuntimeError::new("BAD_PATH", "不能写入工作区根目录")); }
        self.ensure_parent_dirs(&rel)?;
        let encoded = encode_base64(data);
        self.app.saf().write(&self.uri, &rel, &encoded)
            .map_err(|e| RuntimeError::new("WRITE_FAILED", format!("{rel}: {e}")))?;
        Ok(())
    }

    fn read(&self, raw: &str) -> Result<Value, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let data = self.read_bytes(&rel)?;
        let revision = revision_of(Some(&data));
        match std::str::from_utf8(&data) {
            Ok(text) if !data[..data.len().min(4096)].contains(&0) => Ok(json!({
                "path":rel,"content":text,"revision":revision,"size":data.len(),"binary":false
            })),
            _ => Ok(json!({"path":rel,"revision":revision,"size":data.len(),"binary":true})),
        }
    }

    fn hash(&self, raw: &str) -> Result<Value, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let stat = self.stat(&rel)?;
        if stat.get("exists").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({"path":rel,"revision":revision_of(None)}));
        }
        if stat.get("type").and_then(Value::as_str) == Some("file") {
            let data = self.read_bytes_unbounded(&rel)?;
            Ok(json!({"path":rel,"revision":revision_of(Some(&data))}))
        } else {
            Ok(json!({"path":rel,"revision":revision_of(None)}))
        }
    }

    fn tree(&self, raw: &str, depth: usize, show_hidden: bool) -> Result<Value, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let stat = self.stat(&rel)?;
        if stat.get("exists").and_then(Value::as_bool) != Some(true)
            || stat.get("type").and_then(Value::as_str) != Some("dir")
        {
            return Err(RuntimeError::new("NOT_A_FOLDER", format!("{rel} 不是文件夹")));
        }
        Ok(Value::Array(self.tree_level(&rel, depth, show_hidden)?))
    }

    fn tree_level(&self, raw: &str, depth: usize, show_hidden: bool) -> Result<Vec<Value>, RuntimeError> {
        let mut entries = self.list_entries(raw)?;
        entries.sort_by_key(|v| (
            v.get("type").and_then(Value::as_str) != Some("dir"),
            v.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase(),
        ));
        let mut out = Vec::new();
        for entry in entries {
            let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
            if name.starts_with(TMP_PREFIX) || (!show_hidden && matches!(name, ".git" | ".DS_Store")) { continue; }
            let path = entry.get("path").and_then(Value::as_str).unwrap_or(name).to_owned();
            let is_dir = entry.get("type").and_then(Value::as_str) == Some("dir");
            let mut node = json!({
                "name":name,"path":path,"type":if is_dir{"dir"}else{"file"},
                "size":entry.get("size").cloned().unwrap_or(json!(0)),
                "mtime":entry.get("mtime").and_then(Value::as_f64).map(|x|x/1000.0).unwrap_or(0.0)
            });
            if is_dir && depth > 1 {
                node["children"] = Value::Array(self.tree_level(&path, depth - 1, show_hidden)?);
            }
            out.push(node);
        }
        Ok(out)
    }

    fn glob(&self, pattern:&str, max_results:usize)->Result<Value,RuntimeError>{
        if pattern.trim().is_empty(){return Err(RuntimeError::new("BAD_QUERY","glob pattern 不能为空"));}
        let mut paths=Vec::new();self.glob_dir(".",pattern,max_results,&mut paths)?;Ok(json!({"paths":paths,"truncated":paths.len()>=max_results}))
    }

    fn glob_dir(&self,raw:&str,pattern:&str,max_results:usize,out:&mut Vec<String>)->Result<(),RuntimeError>{
        if out.len()>=max_results{return Ok(());}for entry in self.list_entries(raw)?{if out.len()>=max_results{break;}let name=entry.get("name").and_then(Value::as_str).unwrap_or("");let path=entry.get("path").and_then(Value::as_str).unwrap_or("");let is_dir=entry.get("type").and_then(Value::as_str)==Some("dir");if is_dir&&matches!(name,".git"|"node_modules"|"target"|".gradle"|".idea"|"__pycache__"|".venv"|"venv"){continue;}if wildcard_match(pattern,path){out.push(path.to_owned());}if is_dir{self.glob_dir(path,pattern,max_results,out)?;}}Ok(())
    }

    fn search(&self, query: &str, case_sensitive: bool, max_results: usize) -> Result<Value, RuntimeError> {
        if query.is_empty() { return Err(RuntimeError::new("BAD_QUERY", "搜索内容不能为空")); }
        let needle = if case_sensitive { query.to_owned() } else { query.to_lowercase() };
        let mut matches = Vec::new();
        let mut scanned = 0usize;
        self.search_dir(".", &needle, case_sensitive, max_results, &mut matches, &mut scanned)?;
        Ok(json!({"matches":matches,"files_scanned":scanned,"truncated":matches.len()>=max_results}))
    }

    fn search_dir(&self, raw: &str, needle: &str, case_sensitive: bool, max_results: usize, matches: &mut Vec<Value>, scanned: &mut usize) -> Result<(), RuntimeError> {
        if matches.len() >= max_results { return Ok(()); }
        for entry in self.list_entries(raw)? {
            if matches.len() >= max_results { break; }
            let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
            if matches!(name, ".git" | "node_modules" | "__pycache__" | ".venv" | "venv" | ".gradle" | ".idea") { continue; }
            let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
            if entry.get("type").and_then(Value::as_str) == Some("dir") {
                self.search_dir(path, needle, case_sensitive, max_results, matches, scanned)?;
                continue;
            }
            if entry.get("size").and_then(Value::as_u64).unwrap_or(0) > 1_000_000 { continue; }
            let Ok(data) = self.read_bytes_unbounded(path) else { continue; };
            if data[..data.len().min(4096)].contains(&0) { continue; }
            let Ok(text) = std::str::from_utf8(&data) else { continue; };
            *scanned += 1;
            for (idx,line) in text.lines().enumerate() {
                let hay = if case_sensitive { line.to_owned() } else { line.to_lowercase() };
                if let Some(column) = hay.find(needle) {
                    matches.push(json!({"path":path,"line":idx+1,"column":column+1,"text":line.chars().take(300).collect::<String>()}));
                    if matches.len() >= max_results { break; }
                }
            }
        }
        Ok(())
    }

    fn commit_bytes(&self, raw: &str, data: &[u8], base_revision: Option<&str>) -> Result<Mutation, RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let stat = self.stat(&rel)?;
        if stat.get("exists").and_then(Value::as_bool) == Some(true)
            && stat.get("type").and_then(Value::as_str) != Some("file")
        {
            return Err(RuntimeError::new("NOT_A_FILE", format!("{rel} 不是文件")));
        }
        let before = if stat.get("exists").and_then(Value::as_bool) == Some(true) {
            Some(self.read_bytes_unbounded(&rel)?)
        } else { None };
        let current = revision_of(before.as_deref());
        if let Some(base) = base_revision {
            if base != current {
                return Err(RuntimeError::new("CONFLICT", format!("{rel} 在读取之后已被修改，请重新读取后再试"))
                    .with_data(json!({"current_revision":current})));
            }
        }
        if before.as_deref() == Some(data) {
            return Ok(Mutation{changed:false,result:json!({"path":rel,"revision":current,"changed":false}),event:json!({})});
        }
        if let Err(error) = self.write_raw(&rel, data) {
            match before.as_deref() {
                Some(previous) => {
                    let _ = self.write_raw(&rel, previous);
                }
                None => {
                    let _ = self.app.saf().delete(&self.uri, &rel);
                }
            }
            return Err(error);
        }
        let after_rev = revision_of(Some(data));
        let kind = if before.is_some(){"modify"}else{"create"};
        Ok(Mutation{changed:true,result:json!({"path":rel,"revision":after_rev,"changed":true}),event:json!({
            "kind":kind,"path":rel,"before_text":event_text(before.as_deref()),"after_text":event_text(Some(data)),
            "before_rev":revision_of(before.as_deref()),"after_rev":after_rev,"actor":"user","task_id":null
        })})
    }

    fn write_text(&self, raw:&str, content:&str, base_revision:Option<&str>) -> Result<Mutation,RuntimeError> {
        self.commit_bytes(raw, content.as_bytes(), base_revision)
    }

    fn write_bytes_protected(&self, raw:&str, data:&[u8], base_revision:Option<&str>) -> Result<Mutation,RuntimeError> {
        self.commit_bytes(raw,data,base_revision)
    }

    fn set_executable_protected(&self, _raw:&str, _executable:bool) -> Result<(),RuntimeError> {
        Err(RuntimeError::new("WORKSPACE_CAPABILITY", "Android SAF 工作区没有 POSIX 可执行位"))
    }

    fn begin_write(&self, raw:&str, base_revision:Option<&str>) -> Result<Value,RuntimeError> {
        let rel = Self::clean_rel(raw)?;
        let current = self.hash(&rel)?.get("revision").and_then(Value::as_str).unwrap_or("absent").to_owned();
        if let Some(base)=base_revision { if base != current { return Err(RuntimeError::new("CONFLICT",format!("{rel} 在读取之后已被修改，请重新读取后再试")).with_data(json!({"current_revision":current}))); } }
        let pending_dir = self.checkpoints.base_dir().join("pending-writes");
        fs::create_dir_all(&pending_dir).map_err(io_err("WRITE_FAILED", &pending_dir.to_string_lossy()))?;
        let id=unique_id("w");
        let temp=pending_dir.join(format!("{id}.tmp"));
        OpenOptions::new().create_new(true).write(true).open(&temp).map_err(io_err("WRITE_FAILED",&rel))?;
        self.writes.borrow_mut().insert(id.clone(),SafPendingWrite{path:rel,temp,next_seq:0,bytes:0,base_revision:base_revision.map(ToOwned::to_owned)});
        Ok(json!({"write_id":id}))
    }

    fn write_chunk(&self, id:&str, seq:usize, data:&str, encoding:&str) -> Result<Value,RuntimeError> {
        let mut writes=self.writes.borrow_mut();
        let pending=writes.get_mut(id).ok_or_else(||RuntimeError::new("NO_SUCH_WRITE","写入事务不存在或已结束"))?;
        if seq != pending.next_seq {
            let expected=pending.next_seq; let temp=pending.temp.clone(); writes.remove(id); let _=fs::remove_file(temp);
            return Err(RuntimeError::new("SEQUENCE_ERROR",format!("写入块顺序错误：期望 {expected}，收到 {seq}；写入已中止")));
        }
        let bytes=match encoding {"utf-8"|"utf8"=>data.as_bytes().to_vec(),"base64"=>decode_base64(data)?,_=>return Err(RuntimeError::new("BAD_ENCODING","分块写入只支持 utf-8 或 base64"))};
        let mut file=OpenOptions::new().append(true).open(&pending.temp).map_err(io_err("WRITE_FAILED",id))?;
        file.write_all(&bytes).map_err(io_err("WRITE_FAILED",id))?;
        pending.bytes+=bytes.len(); pending.next_seq+=1;
        Ok(json!({"received_bytes":pending.bytes,"next_seq":pending.next_seq}))
    }

    fn commit_write(&self,id:&str,total_bytes:usize,expected_sha256:&str)->Result<Mutation,RuntimeError>{
        let pending=self.writes.borrow_mut().remove(id).ok_or_else(||RuntimeError::new("NO_SUCH_WRITE","写入事务不存在或已结束"))?;
        let result=(||{
            if pending.bytes!=total_bytes{return Err(RuntimeError::new("BYTE_COUNT_MISMATCH",format!("收到 {} 字节，期望 {total_bytes} 字节",pending.bytes)));}
            let data=fs::read(&pending.temp).map_err(io_err("READ_FAILED",id))?;
            let actual=sha256_hex(&data); let expected=expected_sha256.strip_prefix("sha256:").unwrap_or(expected_sha256);
            if actual!=expected{return Err(RuntimeError::new("HASH_MISMATCH","内容哈希不匹配；原文件未被改动").with_data(json!({"actual":actual,"expected":expected})));}
            self.commit_bytes(&pending.path,&data,pending.base_revision.as_deref())
        })();
        let _=fs::remove_file(&pending.temp); result
    }

    fn abort_write(&self,id:&str)->Result<Value,RuntimeError>{
        let pending=self.writes.borrow_mut().remove(id); if let Some(p)=pending.as_ref(){let _=fs::remove_file(&p.temp);} Ok(json!({"aborted":pending.is_some()}))
    }

    fn create(&self,raw:&str,kind:&str,content:&str)->Result<Mutation,RuntimeError>{
        let rel=Self::clean_rel(raw)?; if rel=="."{return Err(RuntimeError::new("ALREADY_EXISTS","工作区根目录已经存在"));}
        if self.exists(&rel)?{return Err(RuntimeError::new("ALREADY_EXISTS",format!("{rel} 已存在")));}
        match kind{
            "dir"|"folder"=>{self.app.saf().create(&self.uri,&rel,"dir").map_err(|e|RuntimeError::new("CREATE_FAILED",format!("{rel}: {e}")))?;Ok(Mutation{changed:true,result:json!({"path":rel,"type":"dir"}),event:json!({"kind":"create","path":rel,"before_text":null,"after_text":null,"before_rev":"absent","after_rev":"absent","actor":"user","task_id":null})})}
            "file"=>self.commit_bytes(&rel,content.as_bytes(),Some("absent")),
            _=>Err(RuntimeError::new("BAD_REQUEST","kind 只能是 file 或 dir"))
        }
    }

    fn patch(&self,raw:&str,base_revision:&str,edits:&[Value])->Result<Mutation,RuntimeError>{
        if base_revision.is_empty(){return Err(RuntimeError::new("NEEDS_REVISION","修改文件需要 base_revision，请先读取该文件"));}
        if edits.is_empty(){return Err(RuntimeError::new("BAD_EDIT","edits 必须是非空列表"));}
        let bytes=self.read_bytes(raw)?;let current=revision_of(Some(&bytes));if current!=base_revision{return Err(RuntimeError::new("CONFLICT",format!("{raw} 在读取之后已被修改，请重新读取后再试")).with_data(json!({"current_revision":current})));}
        let text=std::str::from_utf8(&bytes).map_err(|_|RuntimeError::new("BINARY",format!("{raw} 不是 UTF-8 文本")))?;let next=apply_edits(text,edits)?;self.write_text(raw,&next,Some(base_revision))
    }

    fn stage_to_local(&self, raw:&str, dest:&Path)->Result<(),RuntimeError>{
        let rel=Self::clean_rel(raw)?;let stat=self.stat(&rel)?;if stat.get("exists").and_then(Value::as_bool)!=Some(true){return Err(RuntimeError::new("NOT_FOUND",format!("{rel} 不存在")));}
        if stat.get("type").and_then(Value::as_str)==Some("dir"){
            fs::create_dir_all(dest).map_err(io_err("TRASH_WRITE_FAILED",&dest.to_string_lossy()))?;
            for entry in self.list_entries(&rel)?{let name=entry.get("name").and_then(Value::as_str).unwrap_or("item");let path=entry.get("path").and_then(Value::as_str).unwrap_or("");self.stage_to_local(path,&dest.join(name))?;}
        }else{if let Some(parent)=dest.parent(){fs::create_dir_all(parent).map_err(io_err("TRASH_WRITE_FAILED",&parent.to_string_lossy()))?;}fs::write(dest,self.read_bytes_unbounded(&rel)?).map_err(io_err("TRASH_WRITE_FAILED",&dest.to_string_lossy()))?;}
        Ok(())
    }

    fn upload_from_local(&self, src:&Path, raw:&str)->Result<(),RuntimeError>{
        let rel=Self::clean_rel(raw)?;
        if src.is_dir(){if !self.exists(&rel)?{self.app.saf().create(&self.uri,&rel,"dir").map_err(|e|RuntimeError::new("RESTORE_FAILED",format!("{rel}: {e}")))?;}for entry in fs::read_dir(src).map_err(io_err("RESTORE_FAILED",&src.to_string_lossy()))?{let entry=entry.map_err(|e|RuntimeError::new("RESTORE_FAILED",e.to_string()))?;let name=entry.file_name().to_string_lossy().into_owned();let child=if rel=="."{name}else{format!("{rel}/{name}")};self.upload_from_local(&entry.path(),&child)?;}}
        else{self.write_raw(&rel,&fs::read(src).map_err(io_err("RESTORE_FAILED",&src.to_string_lossy()))?)?;}
        Ok(())
    }

    fn delete(&self,raw:&str)->Result<Mutation,RuntimeError>{
        let rel=Self::clean_rel(raw)?;if rel=="."{return Err(RuntimeError::new("POLICY_DENIED","不能删除工作区根目录"));}
        let stat=self.stat(&rel)?;if stat.get("exists").and_then(Value::as_bool)!=Some(true){return Err(RuntimeError::new("NOT_FOUND",format!("{rel} 不存在")));}
        let before=if stat.get("type").and_then(Value::as_str)==Some("file"){Some(self.read_bytes_unbounded(&rel)?)}else{None};
        let staging=self.checkpoints.base_dir().join("trash-staging").join(unique_id("saf-"));self.stage_to_local(&rel,&staging)?;let trash_id=self.trash.stash_virtual(&rel,&staging)?;
        if let Err(e)=self.app.saf().delete(&self.uri,&rel){let _=self.trash.delete_permanently(&trash_id);return Err(RuntimeError::new("DELETE_FAILED",format!("{rel}: {e}")));}
        Ok(Mutation{changed:true,result:json!({"path":rel,"trash_id":trash_id}),event:json!({"kind":"delete","path":rel,"before_text":event_text(before.as_deref()),"after_text":null,"before_rev":revision_of(before.as_deref()),"after_rev":"absent","actor":"user","task_id":null})})
    }

    fn trash_list(&self)->Result<Vec<Value>,RuntimeError>{self.trash.list()}
    fn trash_delete(&self,id:&str)->Result<(),RuntimeError>{self.trash.delete_permanently(id)}
    fn trash_empty(&self)->Result<usize,RuntimeError>{self.trash.empty()}

    fn restore_from_trash(&self,id:&str)->Result<Mutation,RuntimeError>{
        let (meta,payload)=self.trash.virtual_item(id)?;let rel=meta.get("original").and_then(Value::as_str).ok_or_else(||RuntimeError::new("TRASH_CORRUPT","回收站元数据缺少 original"))?.to_owned();
        if self.exists(&rel)?{return Err(RuntimeError::new("ALREADY_EXISTS",format!("无法恢复：{rel} 已经存在")));}
        let after=if payload.is_file(){Some(fs::read(&payload).map_err(io_err("RESTORE_FAILED",&payload.to_string_lossy()))?)}else{None};
        self.upload_from_local(&payload,&rel)?;self.trash.finish_virtual_restore(id)?;
        Ok(Mutation{changed:true,result:json!({"path":rel}),event:json!({"kind":"create","path":rel,"before_text":null,"after_text":event_text(after.as_deref()),"before_rev":"absent","after_rev":revision_of(after.as_deref()),"actor":"system","task_id":null})})
    }

    fn export_zip(&self,raw:&str,data_dir:&Path)->Result<Value,RuntimeError>{
        let rel=Self::clean_rel(raw)?;let stat=self.stat(&rel)?;if stat.get("exists").and_then(Value::as_bool)!=Some(true){return Err(RuntimeError::new("NOT_FOUND",format!("{rel} 不存在")));}
        let exports=data_dir.join("exports");fs::create_dir_all(&exports).map_err(io_err("EXPORT_FAILED",&exports.to_string_lossy()))?;
        let staging=exports.join(format!(".saf-stage-{}",unique_id("")));let base=if rel=="."{self.name.clone()}else{rel.rsplit('/').next().unwrap_or("project").to_owned()};let staged=staging.join(&base);self.stage_to_local(&rel,&staged)?;
        let output=exports.join(format!("{}-{base}.zip",unique_id("export-")));let result=zip_local_source(&staged,&base,&output);let _=fs::remove_dir_all(&staging);let total=result?;let size=fs::metadata(&output).map_err(io_err("EXPORT_FAILED",&output.to_string_lossy()))?.len();Ok(json!({"native_path":output.to_string_lossy(),"name":format!("{base}.zip"),"size":size,"source_bytes":total}))
    }

    fn checkpoint_tasks(&self,limit:usize)->Result<Vec<Value>,RuntimeError>{self.checkpoints.list_tasks(limit)}
    fn checkpoint_task(&self,id:&str)->Result<Value,RuntimeError>{self.checkpoints.load(id)}

    fn restore_checkpoint_state(&self,rel:&str,existed:bool,blob:Option<&str>)->Result<Option<Value>,RuntimeError>{
        let stat=self.stat(rel)?;
        let exists=stat.get("exists").and_then(Value::as_bool)==Some(true);
        let is_file=stat.get("type").and_then(Value::as_str)==Some("file");
        let current=if exists&&is_file{Some(self.read_bytes_unbounded(rel)?)}else{None};
        if existed{
            let blob=blob.ok_or_else(||RuntimeError::new("CHECKPOINT_CORRUPT","Checkpoint 缺少 blob"))?;
            let data=self.checkpoints.get_blob(blob)?;
            if current.as_deref()==Some(data.as_slice()){return Ok(None);}
            if exists&&!is_file{return Err(RuntimeError::new("NOT_A_FILE",format!("{rel} 当前不是文件")));}
            self.write_raw(rel,&data)?;
            let kind=if current.is_some(){"modify"}else{"create"};
            return Ok(Some(json!({"kind":kind,"path":rel,"before_text":event_text(current.as_deref()),"after_text":event_text(Some(&data)),"before_rev":revision_of(current.as_deref()),"after_rev":revision_of(Some(&data)),"actor":"system","task_id":null})));
        }
        if exists{
            if is_file{
                let before=current.unwrap_or_default();
                let _=self.delete(rel)?;
                return Ok(Some(json!({"kind":"delete","path":rel,"before_text":event_text(Some(&before)),"after_text":null,"before_rev":revision_of(Some(&before)),"after_rev":"absent","actor":"system","task_id":null})));
            }
            self.app.saf().delete(&self.uri,rel).map_err(|e|RuntimeError::new("DELETE_FAILED",format!("{rel}: {e}")))?;
            return Ok(Some(json!({"kind":"delete","path":rel,"before_text":null,"after_text":null,"before_rev":"absent","after_rev":"absent","actor":"system","task_id":null})));
        }
        Ok(None)
    }

    fn checkpoint_diff(&self,task_id:&str,seq:usize)->Result<Value,RuntimeError>{
        let task=self.checkpoints.load(task_id)?;let events=task["events"].as_array().ok_or_else(||RuntimeError::new("CHECKPOINT_CORRUPT","任务 events 无效"))?;let event=events.get(seq).ok_or_else(||RuntimeError::new("BAD_EVENT","Checkpoint 事件编号超出范围"))?;if event["type"].as_str()!=Some("edit"){return Err(RuntimeError::new("NOT_AN_EDIT","这条记录没有可比较的差异"));}let rel=event["path"].as_str().ok_or_else(||RuntimeError::new("CHECKPOINT_CORRUPT","编辑事件缺少 path"))?;let before=event.get("before_blob").and_then(Value::as_str).map(|sha|self.checkpoints.get_blob(sha)).transpose()?;let mut after=None;for later in events.iter().skip(seq+1){if later["type"].as_str()==Some("edit")&&later["path"].as_str()==Some(rel){after=later.get("before_blob").and_then(Value::as_str).map(|sha|self.checkpoints.get_blob(sha)).transpose()?;break;}}if after.is_none(){let stat=self.stat(rel)?;if stat.get("exists").and_then(Value::as_bool)==Some(true)&&stat.get("type").and_then(Value::as_str)==Some("file"){after=Some(self.read_bytes_unbounded(rel)?);}}Ok(json!({"path":rel,"before":event_text(before.as_deref()),"after":event_text(after.as_deref())}))
    }

    fn checkpoint_revert_file(&self,task_id:&str,rel:&str)->Result<BatchMutation,RuntimeError>{let task=self.checkpoints.load(task_id)?;let snap=task["files"].get(rel).ok_or_else(||RuntimeError::new("NOT_IN_TASK",format!("任务 {task_id} 没有改动过 {rel}")))?;let event=self.restore_checkpoint_state(rel,snap["existed"].as_bool().unwrap_or(false),snap.get("blob").and_then(Value::as_str))?;Ok(BatchMutation{result:json!({"reverted":[rel]}),events:event.into_iter().collect()})}

    fn checkpoint_revert_task(&self,task_id:&str)->Result<BatchMutation,RuntimeError>{let task=self.checkpoints.load(task_id)?;let files=task["files"].as_object().ok_or_else(||RuntimeError::new("CHECKPOINT_CORRUPT","任务 files 无效"))?;let mut reverted=Vec::new();let mut emitted=Vec::new();for(rel,snap)in files{if let Some(event)=self.restore_checkpoint_state(rel,snap["existed"].as_bool().unwrap_or(false),snap.get("blob").and_then(Value::as_str))?{emitted.push(event);}reverted.push(rel.clone());}let seqs=task["events"].as_array().map(|events|events.iter().filter(|e|e["type"].as_str()==Some("edit")).filter_map(|e|e["seq"].as_u64().map(|n|n as usize)).collect::<Vec<_>>()).unwrap_or_default();self.checkpoints.mark_reverted(task_id,&seqs)?;let _=self.checkpoints.add_event(task_id,"revert",&format!("已将 {} 个文件恢复到任务开始之前",reverted.len()),json!({}));Ok(BatchMutation{result:json!({"reverted":reverted}),events:emitted})}

    fn checkpoint_revert_event(&self,task_id:&str,seq:usize,force:bool)->Result<BatchMutation,RuntimeError>{let task=self.checkpoints.load(task_id)?;let event=task["events"].as_array().and_then(|x|x.get(seq)).ok_or_else(||RuntimeError::new("BAD_EVENT","Checkpoint 事件编号超出范围"))?;let kind=event["kind"].as_str().unwrap_or("");if event["type"].as_str()!=Some("edit")||!matches!(kind,"create"|"modify"|"delete"){return Err(RuntimeError::new("NOT_REVERTIBLE","这条记录无法单独撤销"));}let rel=event["path"].as_str().ok_or_else(||RuntimeError::new("CHECKPOINT_CORRUPT","编辑事件缺少 path"))?;let stat=self.stat(rel)?;let current=if stat.get("exists").and_then(Value::as_bool)==Some(true)&&stat.get("type").and_then(Value::as_str)==Some("file"){Some(self.read_bytes_unbounded(rel)?)}else{None};if !force{let expected=event["after_rev"].as_str().unwrap_or("absent");let actual=revision_of(current.as_deref());if actual!=expected{return Err(RuntimeError::new("CONFLICT",format!("{rel} 在这一步之后又被修改过，撤销会丢失后续的工作")).with_data(json!({"current_revision":actual})));}}let restored=self.restore_checkpoint_state(rel,event["existed_before"].as_bool().unwrap_or(false),event.get("before_blob").and_then(Value::as_str))?;self.checkpoints.mark_reverted(task_id,&[seq])?;Ok(BatchMutation{result:json!({"reverted":[rel]}),events:restored.into_iter().collect()})}

    fn rename(&self,from:&str,to:&str)->Result<Mutation,RuntimeError>{let from=Self::clean_rel(from)?;let to=Self::clean_rel(to)?;if !self.exists(&from)?{return Err(RuntimeError::new("NOT_FOUND",format!("{from} 不存在")));}if self.exists(&to)?{return Err(RuntimeError::new("ALREADY_EXISTS",format!("{to} 已存在")));}self.ensure_parent_dirs(&to)?;self.app.saf().rename(&self.uri,&from,&to).map_err(|e|RuntimeError::new("RENAME_FAILED",format!("{from}: {e}")))?;Ok(Mutation{changed:true,result:json!({"path":to}),event:json!({"kind":"rename","path":to,"old_path":from,"before_text":null,"after_text":null,"before_rev":"absent","after_rev":"absent","actor":"user","task_id":null})})}

    fn copy(&self,from:&str,to:&str)->Result<Value,RuntimeError>{let from=Self::clean_rel(from)?;let to=Self::clean_rel(to)?;if !self.exists(&from)?{return Err(RuntimeError::new("NOT_FOUND",format!("{from} 不存在")));}if self.exists(&to)?{return Err(RuntimeError::new("ALREADY_EXISTS",format!("{to} 已存在")));}self.ensure_parent_dirs(&to)?;self.app.saf().copy(&self.uri,&from,&to).map_err(|e|RuntimeError::new("COPY_FAILED",format!("{from}: {e}")))?;Ok(json!({"path":to}))}
}

fn zip_local_source(source:&Path, archive_root:&str, output:&Path)->Result<u64,RuntimeError>{
    let file=File::create(output).map_err(io_err("EXPORT_FAILED",&output.to_string_lossy()))?;let mut zip=zip::ZipWriter::new(file);let options=zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);let mut total=0u64;
    fn add(zip:&mut zip::ZipWriter<File>,source:&Path,name:&str,options:zip::write::SimpleFileOptions,total:&mut u64)->Result<(),RuntimeError>{let meta=fs::symlink_metadata(source).map_err(io_err("EXPORT_FAILED",&source.to_string_lossy()))?;if meta.file_type().is_symlink(){return Ok(());}if meta.is_file(){*total=total.saturating_add(meta.len());if *total>EXPORT_MAX_TOTAL{return Err(RuntimeError::new("EXPORT_TOO_LARGE","内容超过 300 MB，无法一次性导出，请分批导出子文件夹"));}zip.start_file(name.replace('\\',"/"),options).map_err(|e|RuntimeError::new("EXPORT_FAILED",e.to_string()))?;let mut input=File::open(source).map_err(io_err("EXPORT_FAILED",&source.to_string_lossy()))?;std::io::copy(&mut input,zip).map_err(io_err("EXPORT_FAILED",&source.to_string_lossy()))?;return Ok(());}if meta.is_dir(){let mut entries=fs::read_dir(source).map_err(io_err("EXPORT_FAILED",&source.to_string_lossy()))?.filter_map(Result::ok).collect::<Vec<_>>();entries.sort_by_key(|e|e.file_name().to_string_lossy().to_lowercase());for entry in entries{let child=entry.path();let child_name=entry.file_name().to_string_lossy().into_owned();if entry.file_type().map(|t|t.is_dir()).unwrap_or(false)&&EXPORT_SKIP_DIRS.contains(&child_name.as_str()){continue;}let dest=if name.is_empty(){child_name}else{format!("{name}/{child_name}")};add(zip,&child,&dest,options,total)?;}}Ok(())}
    if let Err(error)=add(&mut zip,source,archive_root,options,&mut total){drop(zip);let _=fs::remove_file(output);return Err(error);}zip.finish().map_err(|e|RuntimeError::new("EXPORT_FAILED",e.to_string()))?;Ok(total)
}

fn apply_edits(text: &str, edits: &[Value]) -> Result<String, RuntimeError> {
    let crlf = text.contains("\r\n");
    let normalized = text.replace("\r\n", "\n");
    let line_starts = {
        let mut starts = vec![0usize];
        for (idx, b) in normalized.bytes().enumerate() {
            if b == b'\n' {
                starts.push(idx + 1);
            }
        }
        starts
    };

    fn byte_offset(text: &str, starts: &[usize], pos: &Value) -> Result<usize, RuntimeError> {
        let line = pos.get("line").and_then(Value::as_u64).unwrap_or(0) as usize;
        let column = pos.get("column").and_then(Value::as_u64).unwrap_or(0) as usize;
        if line == 0 || line > starts.len() || column == 0 {
            return Err(RuntimeError::new(
                "BAD_RANGE",
                format!("位置超出范围：{pos}"),
            ));
        }
        let start = starts[line - 1];
        let raw_end = if line < starts.len() {
            starts[line] - 1
        } else {
            text.len()
        };
        let line_text = &text[start..raw_end];
        let chars = line_text.chars().count();
        if column > chars + 1 {
            return Err(RuntimeError::new(
                "BAD_RANGE",
                format!("列号超出第 {line} 行的末尾：{pos}"),
            ));
        }
        if column == chars + 1 {
            return Ok(raw_end);
        }
        let rel = line_text
            .char_indices()
            .nth(column - 1)
            .map(|(i, _)| i)
            .unwrap_or(line_text.len());
        Ok(start + rel)
    }

    let mut spans: Vec<(usize, usize, String)> = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let new_text = edit
            .get("new_text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace("\r\n", "\n");
        if let Some(range) = edit.get("range") {
            let start = range.get("start").ok_or_else(|| {
                RuntimeError::new("BAD_RANGE", format!("第 {index} 处修改缺少 start"))
            })?;
            let end = range.get("end").ok_or_else(|| {
                RuntimeError::new("BAD_RANGE", format!("第 {index} 处修改缺少 end"))
            })?;
            let s = byte_offset(&normalized, &line_starts, start)?;
            let t = byte_offset(&normalized, &line_starts, end)?;
            if t < s {
                return Err(RuntimeError::new(
                    "BAD_RANGE",
                    format!("第 {index} 处修改：结束位置在起始位置之前"),
                ));
            }
            spans.push((s, t, new_text));
            continue;
        }
        if let Some(old) = edit.get("old_text").and_then(Value::as_str) {
            let old = old.replace("\r\n", "\n");
            if old.is_empty() {
                return Err(RuntimeError::new(
                    "BAD_EDIT",
                    format!("第 {index} 处修改：old_text 不能为空"),
                ));
            }
            let hits = normalized
                .match_indices(&old)
                .map(|(i, _)| i)
                .collect::<Vec<_>>();
            if hits.is_empty() {
                return Err(RuntimeError::new(
                    "NO_MATCH",
                    format!("第 {index} 处修改：找不到 old_text，请重新读取文件"),
                )
                .with_data(json!({"index":index})));
            }
            let replace_all = edit
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if hits.len() > 1 && !replace_all {
                return Err(RuntimeError::new(
                    "AMBIGUOUS_MATCH",
                    format!(
                        "第 {index} 处修改：old_text 匹配到 {} 处，请增加上下文或设置 replace_all",
                        hits.len()
                    ),
                )
                .with_data(json!({"index":index,"count":hits.len()})));
            }
            for hit in if replace_all {
                hits
            } else {
                hits.into_iter().take(1).collect()
            } {
                spans.push((hit, hit + old.len(), new_text.clone()));
            }
            continue;
        }
        return Err(RuntimeError::new(
            "BAD_EDIT",
            format!("第 {index} 处修改：需要提供 range 或 old_text"),
        ));
    }
    spans.sort_by_key(|(s, e, _)| (*s, *e));
    for pair in spans.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(RuntimeError::new("OVERLAPPING_EDITS", "多处修改互相重叠"));
        }
    }
    let mut out = String::with_capacity(normalized.len());
    let mut cursor = 0usize;
    for (start, end, new_text) in spans {
        out.push_str(&normalized[cursor..start]);
        out.push_str(&new_text);
        cursor = end;
    }
    out.push_str(&normalized[cursor..]);
    if crlf {
        Ok(out.replace('\n', "\r\n"))
    } else {
        Ok(out)
    }
}

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (a << 16) | (b << 8) | c;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 { out.push(TABLE[((n >> 6) & 63) as usize] as char); } else { out.push('='); }
        if chunk.len() > 2 { out.push(TABLE[(n & 63) as usize] as char); } else { out.push('='); }
    }
    out
}

fn decode_base64(input: &str) -> Result<Vec<u8>, RuntimeError> {
    fn val(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(RuntimeError::new("BAD_BASE64", "Base64 长度无效"));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks_exact(4) {
        let a = val(chunk[0])
            .ok_or_else(|| RuntimeError::new("BAD_BASE64", "Base64 包含无效字符"))?
            as u32;
        let b = val(chunk[1])
            .ok_or_else(|| RuntimeError::new("BAD_BASE64", "Base64 包含无效字符"))?
            as u32;
        let c_pad = chunk[2] == b'=';
        let d_pad = chunk[3] == b'=';
        if c_pad && !d_pad {
            return Err(RuntimeError::new("BAD_BASE64", "Base64 padding 无效"));
        }
        let c = if c_pad {
            0
        } else {
            val(chunk[2]).ok_or_else(|| RuntimeError::new("BAD_BASE64", "Base64 包含无效字符"))?
                as u32
        };
        let d = if d_pad {
            0
        } else {
            val(chunk[3]).ok_or_else(|| RuntimeError::new("BAD_BASE64", "Base64 包含无效字符"))?
                as u32
        };
        let n = (a << 18) | (b << 12) | (c << 6) | d;
        out.push((n >> 16) as u8);
        if !c_pad {
            out.push((n >> 8) as u8);
        }
        if !d_pad {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn revision_of(data: Option<&[u8]>) -> String {
    match data {
        Some(data) => format!("sha256:{}", sha256_hex(data)),
        None => "absent".to_string(),
    }
}

fn event_text(data: Option<&[u8]>) -> Option<String> {
    let d = data?;
    if d.len() > MAX_EVENT_TEXT || d[..d.len().min(4096)].contains(&0) {
        return None;
    }
    std::str::from_utf8(d).ok().map(ToOwned::to_owned)
}

fn atomic_write(target: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let temp = parent.join(format!("{TMP_PREFIX}{}", unique_id("")));
    let result = (|| {
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        if let Ok(meta) = fs::metadata(target) {
            fs::set_permissions(&temp, meta.permissions())?;
        }
        atomic_replace(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    // POSIX rename replaces an existing destination atomically when source and destination share a filesystem.
    fs::rename(source, target)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let src: Vec<u16> = source.as_os_str().encode_wide().chain(once(0)).collect();
    let dst: Vec<u16> = target.as_os_str().encode_wide().chain(once(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), RuntimeError> {
    fs::create_dir_all(dst).map_err(io_err("COPY_FAILED", &dst.to_string_lossy()))?;
    for entry in fs::read_dir(src).map_err(io_err("COPY_FAILED", &src.to_string_lossy()))? {
        let entry = entry.map_err(|e| RuntimeError::new("COPY_FAILED", e.to_string()))?;
        let ty = entry
            .file_type()
            .map_err(|e| RuntimeError::new("COPY_FAILED", e.to_string()))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_symlink() {
            return Err(RuntimeError::new(
                "UNSUPPORTED_SYMLINK",
                "复制目录时发现符号链接，已停止以避免越界",
            ));
        }
        if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(io_err("COPY_FAILED", &from.to_string_lossy()))?;
        }
    }
    Ok(())
}

fn io_err(code: &'static str, subject: &str) -> impl FnOnce(std::io::Error) -> RuntimeError {
    let subject = subject.to_owned();
    move |e| RuntimeError::new(code, format!("{subject}: {e}"))
}

#[cfg(test)]
mod studio_boundary_tests {
    use super::*;

    fn fixture() -> (Workspace, PathBuf) {
        let temporary = std::env::temp_dir().join(unique_id("koide-workspace-boundary-"));
        fs::create_dir_all(temporary.join("project")).unwrap();
        fs::create_dir_all(temporary.join("data")).unwrap();
        let workspace = Workspace::open(temporary.join("project").to_str().unwrap(), &temporary.join("data")).unwrap();
        (workspace, temporary)
    }

    #[test]
    fn batch_revision_conflict_never_writes_a_preceding_file() {
        let (workspace, temporary) = fixture();
        let first = workspace.write_text("a.ts", "export const first = 1;", None).unwrap();
        let second = workspace.write_text("b.ts", "export const second = 2;", None).unwrap();
        workspace.write_text("b.ts", "用户刚修改的内容", None).unwrap();
        let task_count = workspace.checkpoint_tasks(100).unwrap().len();
        let error = workspace.apply_text_edits(&[
            json!({"path":"a.ts","revision":first.result["revision"],"content":"改名后内容"}),
            json!({"path":"b.ts","revision":second.result["revision"],"content":"不应覆盖"}),
        ], "符号重命名").unwrap_err();
        assert_eq!(error.code, "REVISION_CONFLICT");
        assert_eq!(workspace.read("a.ts").unwrap()["content"], "export const first = 1;");
        assert_eq!(workspace.read("b.ts").unwrap()["content"], "用户刚修改的内容");
        assert_eq!(workspace.checkpoint_tasks(100).unwrap().len(), task_count);
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn batch_checkpoint_restores_all_files_and_has_edit_events() {
        let (workspace, temporary) = fixture();
        let first = workspace.write_text("a.ts", "export const name = 1;", None).unwrap();
        let second = workspace.write_text("b.ts", "import {name} from './a';", None).unwrap();
        let (result, events) = workspace.apply_text_edits(&[
            json!({"path":"a.ts","revision":first.result["revision"],"content":"export const renamed = 1;"}),
            json!({"path":"b.ts","revision":second.result["revision"],"content":"import {renamed} from './a';"}),
        ], "符号重命名").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(result["files"], 2);
        let task = workspace.checkpoint_task(result["task_id"].as_str().unwrap()).unwrap();
        assert_eq!(task["status"], "done");
        assert_eq!(task["events"].as_array().unwrap().iter().filter(|event|event["type"]=="edit").count(), 2);
        workspace.checkpoint_revert_task(result["task_id"].as_str().unwrap()).unwrap();
        assert_eq!(workspace.read("a.ts").unwrap()["content"], "export const name = 1;");
        assert_eq!(workspace.read("b.ts").unwrap()["content"], "import {name} from './a';");
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn batch_rejects_duplicate_alias_and_hard_policy_before_writing() {
        let (workspace, temporary) = fixture();
        let first = workspace.write_text("src/a.ts", "one", None).unwrap();
        let revision = first.result["revision"].clone();
        let error = workspace.apply_text_edits(&[
            json!({"path":"src/a.ts","revision":revision,"content":"two"}),
            json!({"path":"src/./a.ts","revision":revision,"content":"three"}),
        ], "符号重命名").unwrap_err();
        assert_eq!(error.code, "BAD_EDIT");
        assert_eq!(workspace.read("src/a.ts").unwrap()["content"], "one");
        workspace.write_text(".env", "secret", None).unwrap();
        let error = workspace.apply_text_edits(&[
            json!({"path":"src/a.ts","revision":revision,"content":"two"}),
            json!({"path":".env","revision":workspace.hash(".env").unwrap()["revision"],"content":"exposed"}),
        ], "符号重命名").unwrap_err();
        assert_eq!(error.code, "SENSITIVE_PATH");
        assert_eq!(workspace.read("src/a.ts").unwrap()["content"], "one");
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn terminal_cwd_stays_in_workspace_and_rejects_files() {
        let (workspace, temporary) = fixture();
        workspace.create("nested", "dir", "").unwrap();
        workspace.write_text("file.txt", "one", None).unwrap();
        assert_eq!(workspace.terminal_directory(".").unwrap(), workspace.local_root_path().unwrap());
        assert!(workspace.terminal_directory("nested").unwrap().ends_with("nested"));
        assert_eq!(workspace.terminal_directory("file.txt").unwrap_err().code, "NOT_A_FOLDER");
        assert_eq!(workspace.terminal_directory("../data").unwrap_err().code, "OUTSIDE_WORKSPACE");
        assert_eq!(workspace.terminal_directory(temporary.join("data").to_str().unwrap()).unwrap_err().code, "OUTSIDE_WORKSPACE");
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn unchanged_batch_never_reports_fake_file_edits() {
        let (workspace, temporary) = fixture();
        let file = workspace.write_text("a.ts", "one", None).unwrap();
        let (result, events) = workspace.apply_text_edits(&[json!({"path":"a.ts","revision":file.result["revision"],"content":"one"})], "符号重命名").unwrap();
        assert_eq!(result["files"], 0);
        assert!(events.is_empty());
        fs::remove_dir_all(temporary).unwrap();
    }
}
