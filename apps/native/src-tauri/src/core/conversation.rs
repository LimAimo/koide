use crate::core::id::unique_id;
use crate::core::RuntimeError;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct ConversationStore {
    base: PathBuf,
}

impl ConversationStore {
    pub fn new(base: PathBuf) -> Result<Self, RuntimeError> {
        fs::create_dir_all(&base)
            .map_err(|e| io_err("CONVERSATION_IO", "无法创建会话目录", e))?;
        Ok(Self { base })
    }

    fn path(&self, id: &str) -> Result<PathBuf, RuntimeError> {
        if id.is_empty()
            || id.starts_with('.')
            || id.contains('/')
            || id.contains('\\')
            || id.contains('\0')
        {
            return Err(RuntimeError::new("BAD_CONVERSATION_ID", "会话编号无效"));
        }
        Ok(self.base.join(format!("{id}.json")))
    }

    fn save(&self, conversation: &Value) -> Result<(), RuntimeError> {
        let id = conversation
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::new("BAD_CONVERSATION", "会话缺少 id"))?;
        let target = self.path(id)?;
        let temp = self.base.join(format!(".{}.tmp", unique_id("conversation-")));
        let bytes = serde_json::to_vec_pretty(conversation)
            .map_err(|e| io_err("CONVERSATION_IO", "无法序列化会话", e))?;
        fs::write(&temp, bytes)
            .map_err(|e| io_err("CONVERSATION_IO", "无法写入会话", e))?;
        #[cfg(windows)]
        if target.exists() {
            fs::remove_file(&target)
                .map_err(|e| io_err("CONVERSATION_IO", "无法替换旧会话", e))?;
        }
        fs::rename(&temp, &target)
            .map_err(|e| io_err("CONVERSATION_IO", "无法保存会话", e))
    }

    pub fn create(&self, title: &str) -> Result<Value, RuntimeError> {
        let now = now_secs();
        let id = unique_id("conv-");
        let conversation = json!({
            "id": id,
            "title": if title.trim().is_empty() { "新对话" } else { title.trim() }.chars().take(60).collect::<String>(),
            "created": now,
            "updated": now,
            "entries": []
        });
        self.save(&conversation)?;
        Ok(conversation)
    }

    pub fn get(&self, id: &str) -> Result<Value, RuntimeError> {
        let path = self.path(id)?;
        let text = fs::read_to_string(&path)
            .map_err(|_| RuntimeError::new("NO_CONVERSATION", "找不到这个会话"))?;
        serde_json::from_str(&text)
            .map_err(|e| io_err("CONVERSATION_IO", "会话文件损坏", e))
    }

    pub fn append(&self, id: &str, entries: Vec<Value>) -> Result<(), RuntimeError> {
        let mut conversation = self.get(id)?;
        let target = conversation
            .get_mut("entries")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| RuntimeError::new("BAD_CONVERSATION", "会话 entries 损坏"))?;
        target.extend(entries);
        conversation["updated"] = json!(now_secs());
        self.save(&conversation)
    }

    pub fn list(&self) -> Result<Vec<Value>, RuntimeError> {
        let mut out = Vec::new();
        let entries = fs::read_dir(&self.base)
            .map_err(|e| io_err("CONVERSATION_IO", "无法读取会话目录", e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
            let Some(id) = value.get("id").and_then(Value::as_str) else { continue };
            let title = value.get("title").and_then(Value::as_str).unwrap_or("新对话");
            let updated = value.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
            let count = value
                .get("entries")
                .and_then(Value::as_array)
                .map(|x| x.len())
                .unwrap_or(0);
            out.push(json!({"id": id, "title": title, "updated": updated, "count": count}));
        }
        out.sort_by(|a, b| {
            b.get("updated")
                .and_then(Value::as_f64)
                .partial_cmp(&a.get("updated").and_then(Value::as_f64))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(out)
    }

    pub fn delete(&self, id: &str) -> Result<(), RuntimeError> {
        let path = self.path(id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err("CONVERSATION_IO", "无法删除会话", e)),
        }
    }

    pub fn messages(&self, id: &str) -> Result<Vec<Value>, RuntimeError> {
        let conversation = self.get(id)?;
        let entries = conversation
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let last_compact = entries
            .iter()
            .rposition(|entry| entry.get("role").and_then(Value::as_str) == Some("compact"));
        let mut messages = Vec::new();
        let start = if let Some(i) = last_compact {
            if let Some(summary) = entries[i].get("text").and_then(Value::as_str) {
                messages.push(json!({
                    "role": "assistant",
                    "content": format!("[更早对话的摘要]\n{summary}")
                }));
            }
            i + 1
        } else {
            0
        };

        for entry in &entries[start..] {
            let Some(role) = entry.get("role").and_then(Value::as_str) else { continue };
            if !matches!(role, "user" | "assistant") {
                continue;
            }
            let Some(text) = entry.get("text").and_then(Value::as_str) else { continue };
            if !text.is_empty() {
                messages.push(json!({"role": role, "content": text}));
            }
        }
        Ok(messages)
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn io_err(code: &'static str, subject: &str, e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::new(code, format!("{subject}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_like_ids() {
        let store = ConversationStore { base: PathBuf::from(".") };
        assert!(store.path("../oops").is_err());
        assert!(store.path("a/b").is_err());
        assert!(store.path("a\\b").is_err());
    }
}
