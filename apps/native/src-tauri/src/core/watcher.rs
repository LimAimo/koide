use crate::core::RuntimeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_ENTRIES: usize = 20_000;
const MAX_CHANGES: usize = 500;
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".gradle", ".idea",
];

type Stamp = (u128, u64, bool);
type Snapshot = HashMap<String, Stamp>;

#[derive(Clone, Serialize)]
struct RuntimeEvent {
    event: String,
    data: Value,
}

pub struct WorkspaceWatcher {
    stop: Arc<AtomicBool>,
}

impl WorkspaceWatcher {
    pub fn start(app: AppHandle, root: PathBuf) -> Result<Self, RuntimeError> {
        if !root.is_dir() {
            return Err(RuntimeError::new("WATCH_FAILED", "工作区不存在"));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        thread::spawn(move || {
            let mut last = snapshot(&root);
            while !flag.load(Ordering::SeqCst) {
                for _ in 0..4 {
                    if flag.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(90));
                }
                let current = snapshot(&root);
                let changes = diff(&last, &current);
                last = current;
                if changes.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "diffusion://event",
                    RuntimeEvent {
                        event: "fs.external".into(),
                        data: json!({
                            "changes": changes.into_iter().take(MAX_CHANGES).map(|(path,kind)| {
                                json!({"path":path,"kind":kind})
                            }).collect::<Vec<_>>()
                        }),
                    },
                );
            }
        });
        Ok(Self { stop })
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn snapshot(root: &Path) -> Snapshot {
    let mut out = HashMap::new();
    scan(root, root, &mut out);
    out
}

fn scan(root: &Path, dir: &Path, out: &mut Snapshot) {
    if out.len() >= MAX_ENTRIES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.filter_map(Result::ok) {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let Ok(ty) = entry.file_type() else { continue };
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if ty.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, (modified, 0, true));
            }
            scan(root, &path, out);
            continue;
        }
        if !ty.is_file() || name.starts_with(".diffusion-tmp-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        out.insert(rel, (modified, meta.len(), false));
    }
}

fn diff(old: &Snapshot, new: &Snapshot) -> Vec<(String, &'static str)> {
    let mut out = Vec::new();
    for path in new.keys() {
        match old.get(path) {
            None => out.push((path.clone(), "create")),
            Some(before) if Some(before) != new.get(path) => out.push((path.clone(), "modify")),
            _ => {}
        }
    }
    for path in old.keys() {
        if !new.contains_key(path) {
            out.push((path.clone(), "delete"));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_detects_create_delete_modify() {
        let old = HashMap::from([
            ("a".into(), (1, 1, false)),
            ("b".into(), (1, 1, false)),
        ]);
        let new = HashMap::from([
            ("a".into(), (2, 1, false)),
            ("c".into(), (1, 1, false)),
        ]);
        assert_eq!(
            diff(&old, &new),
            vec![
                ("a".into(), "modify"),
                ("b".into(), "delete"),
                ("c".into(), "create")
            ]
        );
    }
}
