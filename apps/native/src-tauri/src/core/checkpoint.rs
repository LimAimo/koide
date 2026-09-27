use super::crypto::sha256_hex;
use super::id::unique_id;
use super::RuntimeError;
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct CheckpointStore {
    base: PathBuf,
    blobs: PathBuf,
    tasks: PathBuf,
}

impl CheckpointStore {
    pub fn new(base: PathBuf) -> Result<Self, RuntimeError> {
        let blobs = base.join("blobs");
        let tasks = base.join("tasks");
        fs::create_dir_all(&blobs)
            .map_err(io_err("CHECKPOINT_INIT_FAILED", &blobs.to_string_lossy()))?;
        fs::create_dir_all(&tasks)
            .map_err(io_err("CHECKPOINT_INIT_FAILED", &tasks.to_string_lossy()))?;
        Ok(Self { base, blobs, tasks })
    }

    pub fn base_dir(&self) -> &Path {
        &self.base
    }

    pub fn put_blob(&self, data: &[u8]) -> Result<String, RuntimeError> {
        let sha = sha256_hex(data);
        let path = self.blobs.join(&sha);
        if !path.exists() {
            let temp = self.blobs.join(format!(".{sha}.{}.tmp", unique_id("")));
            fs::write(&temp, data)
                .map_err(io_err("CHECKPOINT_WRITE_FAILED", &temp.to_string_lossy()))?;
            fs::rename(&temp, &path)
                .map_err(io_err("CHECKPOINT_WRITE_FAILED", &path.to_string_lossy()))?;
        }
        Ok(sha)
    }

    pub fn get_blob(&self, sha: &str) -> Result<Vec<u8>, RuntimeError> {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeError::new("BAD_BLOB_ID", "Checkpoint blob 编号无效"));
        }
        fs::read(self.blobs.join(sha)).map_err(io_err("CHECKPOINT_BLOB_NOT_FOUND", sha))
    }

    fn task_path(&self, task_id: &str) -> Result<PathBuf, RuntimeError> {
        if task_id.is_empty()
            || task_id.contains('/')
            || task_id.contains('\\')
            || task_id.starts_with('.')
        {
            return Err(RuntimeError::new("BAD_TASK_ID", "Checkpoint 任务编号无效"));
        }
        Ok(self.tasks.join(format!("{task_id}.json")))
    }

    pub fn load(&self, task_id: &str) -> Result<Value, RuntimeError> {
        let path = self.task_path(task_id)?;
        let bytes = fs::read(&path).map_err(io_err("UNKNOWN_TASK", task_id))?;
        serde_json::from_slice(&bytes)
            .map_err(|e| RuntimeError::new("CHECKPOINT_CORRUPT", format!("{task_id}: {e}")))
    }

    fn save(&self, task: &Value) -> Result<(), RuntimeError> {
        let id = task["id"]
            .as_str()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "任务缺少 id"))?;
        let path = self.task_path(id)?;
        let temp = self.tasks.join(format!(".{id}.{}.tmp", unique_id("")));
        let bytes = serde_json::to_vec_pretty(task)
            .map_err(|e| RuntimeError::new("CHECKPOINT_WRITE_FAILED", e.to_string()))?;
        fs::write(&temp, bytes)
            .map_err(io_err("CHECKPOINT_WRITE_FAILED", &temp.to_string_lossy()))?;
        fs::rename(&temp, &path).map_err(io_err("CHECKPOINT_WRITE_FAILED", &path.to_string_lossy()))
    }

    pub fn start_task(&self, goal: &str, mode: &str) -> Result<Value, RuntimeError> {
        let id = format!(
            "{}-{}",
            unix_seconds(),
            unique_id("").chars().take(8).collect::<String>()
        );
        let task = json!({
            "id": id,
            "goal": goal,
            "mode": mode,
            "started": unix_seconds_f64(),
            "ended": null,
            "status": "running",
            "files": {},
            "events": []
        });
        self.save(&task)?;
        self.add_event(
            task["id"].as_str().unwrap_or_default(),
            "task_started",
            "任务开始",
            json!({"detail": goal.chars().take(300).collect::<String>()}),
        )?;
        self.load(task["id"].as_str().unwrap_or_default())
    }

    pub fn finish_task(
        &self,
        task_id: &str,
        status: &str,
        summary: &str,
    ) -> Result<(), RuntimeError> {
        let mut task = self.load(task_id)?;
        task["status"] = Value::String(status.to_owned());
        task["ended"] = json!(unix_seconds_f64());
        self.save(&task)?;
        let title = match status {
            "done" => "任务完成",
            "incomplete" => "任务可能未完成",
            "stopped" => "任务已停止",
            "error" => "任务失败",
            other => other,
        };
        self.add_event(
            task_id,
            if status == "done" {
                "task_complete"
            } else {
                "task_status"
            },
            title,
            json!({"detail": summary.chars().take(500).collect::<String>()}),
        )?;
        Ok(())
    }

    pub fn add_event(
        &self,
        task_id: &str,
        kind: &str,
        title: &str,
        extra: Value,
    ) -> Result<Value, RuntimeError> {
        let mut task = self.load(task_id)?;
        let events = task["events"]
            .as_array_mut()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "任务 events 无效"))?;
        let mut event = Map::new();
        event.insert("seq".into(), json!(events.len()));
        event.insert("ts".into(), json!(unix_seconds_f64()));
        event.insert("type".into(), json!(kind));
        event.insert("title".into(), json!(title));
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                event.insert(k.clone(), v.clone());
            }
        }
        let event = Value::Object(event);
        events.push(event.clone());
        self.save(&task)?;
        Ok(event)
    }

    pub fn record_before(
        &self,
        task_id: &str,
        rel: &str,
        data: Option<&[u8]>,
    ) -> Result<Value, RuntimeError> {
        let mut task = self.load(task_id)?;
        let files = task["files"]
            .as_object_mut()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "任务 files 无效"))?;
        if !files.contains_key(rel) {
            let blob = match data {
                Some(bytes) => Some(self.put_blob(bytes)?),
                None => None,
            };
            files.insert(
                rel.to_owned(),
                json!({"existed": data.is_some(), "blob": blob}),
            );
            self.save(&task)?;
        }
        Ok(task["files"][rel].clone())
    }

    pub fn blob_for_event_before(
        &self,
        data: Option<&[u8]>,
    ) -> Result<Option<String>, RuntimeError> {
        data.map(|d| self.put_blob(d)).transpose()
    }

    pub fn mark_reverted(&self, task_id: &str, seqs: &[usize]) -> Result<(), RuntimeError> {
        let mut task = self.load(task_id)?;
        let events = task["events"]
            .as_array_mut()
            .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "任务 events 无效"))?;
        for &seq in seqs {
            if let Some(event) = events.get_mut(seq).and_then(Value::as_object_mut) {
                event.insert("reverted".into(), Value::Bool(true));
            }
        }
        self.save(&task)
    }

    /// Resolve only the after-version recorded by this event, never an unrelated current file.
    /// The same resolver is used by LocalFS and Android SAF.
    pub fn event_after<F>(&self, events: &[Value], seq: usize, current: F) -> Result<Option<Vec<u8>>, RuntimeError>
    where F: FnOnce() -> Result<Option<Vec<u8>>, RuntimeError> {
        let event = events.get(seq).ok_or_else(|| RuntimeError::new("BAD_EVENT", "Checkpoint 事件编号超出范围"))?;
        let expected = event["after_rev"].as_str();
        let matches = |data: Option<&[u8]>| {
            let revision = data.map(|bytes| format!("sha256:{}", sha256_hex(bytes))).unwrap_or_else(|| "absent".into());
            expected == Some(revision.as_str())
        };
        let blob = |value: &Value| value.as_str().map(|sha| self.get_blob(sha)).transpose();
        let after = if let Some(value) = event.get("after_blob") {
            blob(value)?
        } else if expected == Some("absent") {
            None
        } else {
            let next = events.iter().skip(seq + 1).find(|later| later["type"] == "edit" && later["path"] == event["path"]);
            let candidate = next.map(|later| blob(&later["before_blob"])).transpose()?.flatten();
            if matches(candidate.as_deref()) { candidate } else { current()? }
        };
        if !matches(after.as_deref()) {
            return Err(RuntimeError::new("HISTORY_UNAVAILABLE", "这条旧记录没有保存修改后快照，现有文件也不再匹配当时版本"));
        }
        Ok(after)
    }

    pub fn list_tasks(&self, limit: usize) -> Result<Vec<Value>, RuntimeError> {
        let mut paths = fs::read_dir(&self.tasks)
            .map_err(io_err(
                "CHECKPOINT_READ_FAILED",
                &self.tasks.to_string_lossy(),
            ))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        paths.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        let mut out = Vec::new();
        for path in paths.into_iter().take(limit) {
            let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
                continue;
            };
            let Ok(task) = self.load(stem) else {
                continue;
            };
            let files = task["files"]
                .as_object()
                .map(|x| x.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let events = task["events"].as_array().map(Vec::len).unwrap_or(0);
            out.push(json!({
                "id": task["id"], "goal": task["goal"], "status": task["status"],
                "started": task["started"], "ended": task["ended"], "files": files, "events": events
            }));
        }
        Ok(out)
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
fn io_err(code: &'static str, subject: &str) -> impl FnOnce(std::io::Error) -> RuntimeError {
    let subject = subject.to_owned();
    move |e| RuntimeError::new(code, format!("{subject}: {e}"))
}

#[cfg(test)]
mod history_tests {
    use super::*;

    #[test]
    fn immutable_after_does_not_read_current_workspace() {
        let base = std::env::temp_dir().join(unique_id("koide-history-"));
        let store = CheckpointStore::new(base.clone()).unwrap();
        let blob = store.put_blob(b"then").unwrap();
        let events = vec![json!({"path":"a", "type":"edit", "after_blob":blob, "after_rev":format!("sha256:{}", sha256_hex(b"then")), "reverted":true})];
        assert_eq!(store.event_after(&events, 0, || panic!("must not read current file")).unwrap(), Some(b"then".to_vec()));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_candidates_must_match_recorded_revision() {
        let base = std::env::temp_dir().join(unique_id("koide-history-"));
        let store = CheckpointStore::new(base.clone()).unwrap();
        let mut events = vec![json!({"path":"a", "type":"edit", "after_rev":format!("sha256:{}", sha256_hex(b"then"))})];
        assert_eq!(store.event_after(&events, 0, || Ok(Some(b"now".to_vec()))).unwrap_err().code, "HISTORY_UNAVAILABLE");
        let blob = store.put_blob(b"then").unwrap();
        events.push(json!({"path":"a", "type":"edit", "before_blob":blob}));
        assert_eq!(store.event_after(&events, 0, || panic!("next snapshot is sufficient")).unwrap(), Some(b"then".to_vec()));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn historical_delete_stays_absent_after_recreation() {
        let base = std::env::temp_dir().join(unique_id("koide-history-"));
        let store = CheckpointStore::new(base.clone()).unwrap();
        let events = vec![json!({"path":"a", "type":"edit", "after_rev":"absent"})];
        assert_eq!(store.event_after(&events, 0, || panic!("deleted state is known")).unwrap(), None);
        fs::remove_dir_all(base).unwrap();
    }
}
