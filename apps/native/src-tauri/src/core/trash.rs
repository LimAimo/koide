use super::id::unique_id;
use super::RuntimeError;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Trash {
    base: PathBuf,
}

impl Trash {
    pub fn new(base: PathBuf) -> Result<Self, RuntimeError> {
        fs::create_dir_all(&base).map_err(io_err("TRASH_INIT_FAILED", &base.to_string_lossy()))?;
        Ok(Self { base })
    }

    pub fn move_in(&self, abs_path: &Path) -> Result<String, RuntimeError> {
        if !abs_path.exists() {
            return Err(RuntimeError::new(
                "NOT_FOUND",
                format!("{} 不存在", abs_path.display()),
            ));
        }
        let tid = format!(
            "{}-{}",
            unix_seconds(),
            unique_id("").chars().take(10).collect::<String>()
        );
        let slot = self.base.join(&tid);
        fs::create_dir(&slot).map_err(io_err("TRASH_WRITE_FAILED", &slot.to_string_lossy()))?;
        let is_dir = abs_path.is_dir();
        let size = if is_dir {
            0
        } else {
            fs::metadata(abs_path)
                .map_err(io_err("TRASH_WRITE_FAILED", &abs_path.to_string_lossy()))?
                .len()
        };
        let payload = slot.join("payload");
        if let Err(err) = move_path(abs_path, &payload) {
            let _ = fs::remove_dir_all(&slot);
            return Err(err);
        }
        let meta = json!({
            "id": tid,
            "original": abs_path.to_string_lossy(),
            "deleted_at": unix_seconds_f64(),
            "is_dir": is_dir,
            "size": size,
        });
        if let Err(err) = write_json_atomic(&slot.join("meta.json"), &meta) {
            // Best effort rollback: a failed metadata write must not silently eat the user's file.
            let _ = move_path(&payload, abs_path);
            let _ = fs::remove_dir_all(&slot);
            return Err(err);
        }
        Ok(meta["id"].as_str().unwrap_or_default().to_owned())
    }

    pub fn list(&self) -> Result<Vec<Value>, RuntimeError> {
        let mut slots = fs::read_dir(&self.base)
            .map_err(io_err("TRASH_READ_FAILED", &self.base.to_string_lossy()))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect::<Vec<_>>();
        slots.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        let mut out = Vec::new();
        for slot in slots {
            let meta_path = slot.join("meta.json");
            let Ok(bytes) = fs::read(&meta_path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            out.push(meta);
        }
        Ok(out)
    }

    fn slot(&self, id: &str) -> Result<PathBuf, RuntimeError> {
        if id.is_empty() || id.contains('/') || id.contains('\\') || id.starts_with('.') {
            return Err(RuntimeError::new("BAD_TRASH_ID", "回收站编号无效"));
        }
        let slot = self.base.join(id);
        if !slot.join("meta.json").is_file() {
            return Err(RuntimeError::new("TRASH_NOT_FOUND", "回收站里没有这一项"));
        }
        Ok(slot)
    }

    pub fn restore(&self, id: &str, workspace_root: &Path) -> Result<PathBuf, RuntimeError> {
        let slot = self.slot(id)?;
        let meta: Value = serde_json::from_slice(
            &fs::read(slot.join("meta.json")).map_err(io_err("TRASH_READ_FAILED", id))?,
        )
        .map_err(|e| RuntimeError::new("TRASH_CORRUPT", format!("回收站元数据损坏：{e}")))?;
        let original = meta["original"]
            .as_str()
            .ok_or_else(|| RuntimeError::new("TRASH_CORRUPT", "回收站元数据缺少 original"))?;
        let dest = PathBuf::from(original);
        if !dest.is_absolute() || !dest.starts_with(workspace_root) {
            return Err(RuntimeError::new(
                "OUTSIDE_WORKSPACE",
                "拒绝将回收站内容恢复到工作区之外",
            ));
        }
        if dest.exists() {
            return Err(RuntimeError::new(
                "ALREADY_EXISTS",
                format!(
                    "无法恢复：{} 已经存在",
                    dest.file_name().unwrap_or_default().to_string_lossy()
                ),
            ));
        }
        let parent = dest
            .parent()
            .ok_or_else(|| RuntimeError::new("TRASH_RESTORE_FAILED", "恢复目标没有父目录"))?;
        let mut ancestor = parent;
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| RuntimeError::new("OUTSIDE_WORKSPACE", "恢复目标没有有效父目录"))?;
        }
        let canonical_ancestor = fs::canonicalize(ancestor)
            .map_err(io_err("TRASH_RESTORE_FAILED", &ancestor.to_string_lossy()))?;
        if !canonical_ancestor.starts_with(workspace_root) {
            return Err(RuntimeError::new(
                "OUTSIDE_WORKSPACE",
                "恢复目标的父目录通过符号链接指向工作区之外",
            ));
        }
        fs::create_dir_all(parent)
            .map_err(io_err("TRASH_RESTORE_FAILED", &parent.to_string_lossy()))?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(io_err("TRASH_RESTORE_FAILED", &parent.to_string_lossy()))?;
        if !canonical_parent.starts_with(workspace_root) {
            return Err(RuntimeError::new(
                "OUTSIDE_WORKSPACE",
                "恢复目标的父目录通过符号链接指向工作区之外",
            ));
        }
        move_path(&slot.join("payload"), &dest)?;
        fs::remove_dir_all(&slot).map_err(io_err("TRASH_RESTORE_FAILED", id))?;
        Ok(dest)
    }

    pub fn delete_permanently(&self, id: &str) -> Result<(), RuntimeError> {
        let slot = self.slot(id)?;
        fs::remove_dir_all(&slot).map_err(io_err("TRASH_DELETE_FAILED", id))
    }

    pub fn empty(&self) -> Result<usize, RuntimeError> {
        let ids = self
            .list()?
            .into_iter()
            .filter_map(|v| v["id"].as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        let mut removed = 0usize;
        for id in ids {
            if self.delete_permanently(&id).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_seconds_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn move_path(src: &Path, dst: &Path) -> Result<(), RuntimeError> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if src.is_dir() {
        copy_dir(src, dst)?;
        fs::remove_dir_all(src).map_err(io_err("TRASH_MOVE_FAILED", &src.to_string_lossy()))?;
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)
                .map_err(io_err("TRASH_MOVE_FAILED", &parent.to_string_lossy()))?;
        }
        fs::copy(src, dst).map_err(io_err("TRASH_MOVE_FAILED", &src.to_string_lossy()))?;
        fs::remove_file(src).map_err(io_err("TRASH_MOVE_FAILED", &src.to_string_lossy()))?;
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), RuntimeError> {
    fs::create_dir_all(dst).map_err(io_err("TRASH_MOVE_FAILED", &dst.to_string_lossy()))?;
    for entry in fs::read_dir(src).map_err(io_err("TRASH_MOVE_FAILED", &src.to_string_lossy()))? {
        let entry = entry.map_err(|e| RuntimeError::new("TRASH_MOVE_FAILED", e.to_string()))?;
        let ty = entry
            .file_type()
            .map_err(|e| RuntimeError::new("TRASH_MOVE_FAILED", e.to_string()))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_symlink() {
            return Err(RuntimeError::new(
                "UNSUPPORTED_SYMLINK",
                "回收站移动目录时发现符号链接，已停止",
            ));
        }
        if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(io_err("TRASH_MOVE_FAILED", &from.to_string_lossy()))?;
        }
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), RuntimeError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| RuntimeError::new("TRASH_WRITE_FAILED", e.to_string()))?;
    let temp = path.with_extension(unique_id("tmp-"));
    fs::write(&temp, bytes).map_err(io_err("TRASH_WRITE_FAILED", &temp.to_string_lossy()))?;
    fs::rename(&temp, path).map_err(io_err("TRASH_WRITE_FAILED", &path.to_string_lossy()))
}

fn io_err(code: &'static str, subject: &str) -> impl FnOnce(std::io::Error) -> RuntimeError {
    let subject = subject.to_owned();
    move |e| RuntimeError::new(code, format!("{subject}: {e}"))
}
