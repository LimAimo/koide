use crate::core::RuntimeError;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MODES: &[&str] = &["restricted", "manual", "ai", "autonomous"];
const TOOL_SETTINGS: &[&str] = &["deny", "ask", "session", "always", "ai_review"];

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("settings.json") }
    }

    fn load(&self) -> Map<String, Value> {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn save(&self, root: &Map<String, Value>) -> Result<(), RuntimeError> {
        let tmp = self.path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(&Value::Object(root.clone()))
            .map_err(|e| RuntimeError::new("SETTINGS_WRITE_FAILED", e.to_string()))?;
        fs::write(&tmp, bytes)
            .map_err(|e| RuntimeError::new("SETTINGS_WRITE_FAILED", format!("{}: {e}", tmp.display())))?;
        #[cfg(windows)]
        if self.path.exists() {
            fs::remove_file(&self.path)
                .map_err(|e| RuntimeError::new("SETTINGS_WRITE_FAILED", format!("{}: {e}", self.path.display())))?;
        }
        fs::rename(&tmp, &self.path)
            .map_err(|e| RuntimeError::new("SETTINGS_WRITE_FAILED", format!("{}: {e}", self.path.display())))
    }

    pub fn recent(&self) -> Vec<Value> {
        self.load()
            .get("recent")
            .and_then(Value::as_array)
            .map(|xs| xs.iter().filter_map(|item| {
                if let Some(path) = item.as_str() {
                    Some(Value::String(path.to_owned()))
                } else if item.get("kind").and_then(Value::as_str).is_some() {
                    Some(item.clone())
                } else {
                    None
                }
            }).collect())
            .unwrap_or_default()
    }

    fn recent_key(item: &Value) -> Option<String> {
        if let Some(path) = item.as_str() {
            let canonical = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
            return Some(format!("local:{}", canonical.to_string_lossy()));
        }
        match item.get("kind").and_then(Value::as_str) {
            Some("local") => {
                let path = item.get("path").and_then(Value::as_str)?;
                let canonical = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
                Some(format!("local:{}", canonical.to_string_lossy()))
            }
            Some("saf") => item.get("uri").and_then(Value::as_str).map(|uri| format!("saf:{uri}")),
            _ => None,
        }
    }

    pub fn touch_recent_location(&self, location: &Value) -> Result<Vec<Value>, RuntimeError> {
        let normalized = if let Some(path) = location.as_str() {
            let canonical = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
            Value::String(canonical.to_string_lossy().into_owned())
        } else {
            location.clone()
        };
        let key = Self::recent_key(&normalized)
            .ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "无法保存这个最近项目位置"))?;
        let mut root = self.load();
        let mut recent = self.recent();
        recent.retain(|item| Self::recent_key(item).as_deref() != Some(key.as_str()));
        recent.insert(0, normalized);
        recent.truncate(12);
        root.insert("recent".into(), Value::Array(recent.clone()));
        self.save(&root)?;
        Ok(recent)
    }

    pub fn touch_recent(&self, path: &Path) -> Result<Vec<Value>, RuntimeError> {
        self.touch_recent_location(&Value::String(path.to_string_lossy().into_owned()))
    }

    pub fn remove_recent_value(&self, target: &Value) -> Result<Vec<Value>, RuntimeError> {
        let key = Self::recent_key(target)
            .ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "最近项目位置无效"))?;
        let mut root = self.load();
        let mut recent = self.recent();
        recent.retain(|item| Self::recent_key(item).as_deref() != Some(key.as_str()));
        root.insert("recent".into(), Value::Array(recent.clone()));
        self.save(&root)?;
        Ok(recent)
    }

    pub fn remove_recent(&self, raw: &str) -> Result<Vec<Value>, RuntimeError> {
        self.remove_recent_value(&Value::String(raw.to_owned()))
    }

    pub fn permissions(&self) -> Value {
        let root = self.load();
        let src = root.get("permissions").and_then(Value::as_object);
        json!({
            "mode": src.and_then(|x| x.get("mode")).and_then(Value::as_str).filter(|x| MODES.contains(x)).unwrap_or("manual"),
            "tool_settings": src.and_then(|x| x.get("tool_settings")).and_then(Value::as_object).cloned().unwrap_or_default(),
            "tool_rules": src.and_then(|x| x.get("tool_rules")).and_then(Value::as_object).cloned().unwrap_or_default()
        })
    }

    pub fn approval_profile(&self) -> Option<String> {
        self.load()
            .get("approval_profile")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    pub fn update_permissions(&self, patch: &Value) -> Result<Value, RuntimeError> {
        let patch = patch.as_object()
            .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "权限设置必须是对象"))?;
        let mut root = self.load();
        let mut perm = self.permissions().as_object().cloned().unwrap_or_default();

        if let Some(mode) = patch.get("mode").and_then(Value::as_str) {
            if !MODES.contains(&mode) {
                return Err(RuntimeError::new("BAD_PERMISSION_MODE", format!("未知权限模式：{mode}")));
            }
            perm.insert("mode".into(), Value::String(mode.to_owned()));
        }

        if let Some(changes) = patch.get("tool_settings").and_then(Value::as_object) {
            let settings = perm.entry("tool_settings").or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| RuntimeError::new("SETTINGS_CORRUPT", "tool_settings 损坏"))?;
            for (tool, value) in changes {
                if value.is_null() || value.as_str() == Some("") {
                    settings.remove(tool);
                    continue;
                }
                let setting = value.as_str()
                    .ok_or_else(|| RuntimeError::new("BAD_TOOL_SETTING", format!("{tool} 的设置不是字符串")))?;
                if !TOOL_SETTINGS.contains(&setting) {
                    return Err(RuntimeError::new("BAD_TOOL_SETTING", format!("未知工具设置：{setting}")));
                }
                settings.insert(tool.clone(), Value::String(setting.to_owned()));
            }
        }

        if let Some(changes) = patch.get("tool_rules").and_then(Value::as_object) {
            let rules = perm.entry("tool_rules").or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| RuntimeError::new("SETTINGS_CORRUPT", "tool_rules 损坏"))?;
            for (tool, raw) in changes {
                let mut clean = Map::new();
                let obj = raw.as_object();
                for kind in ["allow", "deny"] {
                    let xs = obj
                        .and_then(|o| o.get(kind))
                        .and_then(Value::as_array)
                        .map(|xs| xs.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(|s| Value::String(s.to_owned())).collect::<Vec<_>>())
                        .unwrap_or_default();
                    clean.insert(kind.into(), Value::Array(xs));
                }
                let empty = clean.values().all(|v| v.as_array().is_some_and(Vec::is_empty));
                if empty { rules.remove(tool); } else { rules.insert(tool.clone(), Value::Object(clean)); }
            }
        }

        if patch.contains_key("approval_profile") {
            match patch.get("approval_profile").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(id) => { root.insert("approval_profile".into(), Value::String(id.to_owned())); }
                None => { root.remove("approval_profile"); }
            }
        }

        root.insert("permissions".into(), Value::Object(perm));
        self.save(&root)?;
        Ok(self.permissions())
    }
}

pub fn tool_descriptions() -> Vec<Value> {
    vec![
        tool("fs_read", "read", "low"),
        tool("fs_list", "read", "low"),
        tool("fs_search", "read", "low"),
        tool("fs_glob", "read", "low"),
        tool("fs_multi_read", "read", "low"),
        tool("fs_patch", "write", "medium"),
        tool("fs_write", "write", "medium"),
        tool("fs_create", "write", "medium"),
        tool("fs_delete", "delete", "medium"),
        tool("fs_rename", "write", "medium"),
        tool("fs_copy", "write", "medium"),
        tool("ask_user", "interaction", "low"),
        tool("terminal_read", "exec", "low"),
        tool("shell_run", "exec", "medium"),
        tool("web_fetch", "network", "medium"),
    ]
}

fn tool(id: &str, permission_class: &str, risk: &str) -> Value {
    json!({
        "id": id,
        "permission_class": permission_class,
        "risk": risk,
        "environment": "workspace"
    })
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAction {
    Allow,
    Ask,
    Deny,
    AiReview,
}

#[derive(Debug, Clone)]
pub struct PermissionDecision {
    pub action: PermissionAction,
    pub reason: String,
    pub source: &'static str,
}

impl SettingsStore {
    pub fn evaluate_tool(
        &self,
        tool_id: &str,
        permission_class: &str,
        risk: &str,
        target: &str,
        session_granted: bool,
    ) -> PermissionDecision {
        let cfg = self.permissions();
        let mode = cfg.get("mode").and_then(Value::as_str).unwrap_or("manual");
        let setting = cfg
            .get("tool_settings")
            .and_then(Value::as_object)
            .and_then(|m| m.get(tool_id))
            .and_then(Value::as_str);

        if setting == Some("deny") {
            return PermissionDecision {
                action: PermissionAction::Deny,
                reason: format!("设置中已禁用 {tool_id}"),
                source: "setting",
            };
        }
        if let Some(pattern) = self.rule_hit(tool_id, target, "deny") {
            return PermissionDecision {
                action: PermissionAction::Deny,
                reason: format!("命中了你设置的禁止规则：{pattern}"),
                source: "rule",
            };
        }
        if setting == Some("ask") {
            return PermissionDecision {
                action: PermissionAction::Ask,
                reason: format!("设置中要求每次都询问 {tool_id}"),
                source: "setting",
            };
        }
        if let Some(pattern) = self.rule_hit(tool_id, target, "allow") {
            return PermissionDecision {
                action: PermissionAction::Allow,
                reason: format!("命中了你设置的自动允许规则：{pattern}"),
                source: "rule",
            };
        }
        if matches!(permission_class, "read" | "interaction") {
            return PermissionDecision {
                action: PermissionAction::Allow,
                reason: if permission_class == "read" {
                    "读取工作区内的文件".into()
                } else {
                    "向用户提问".into()
                },
                source: "mode",
            };
        }
        if setting == Some("always") || session_granted {
            return PermissionDecision {
                action: PermissionAction::Allow,
                reason: "你的设置已允许".into(),
                source: "setting",
            };
        }
        if setting == Some("ai_review") || mode == "ai" {
            return PermissionDecision {
                action: PermissionAction::AiReview,
                reason: "交给审批模型判断".into(),
                source: "approval_agent",
            };
        }
        if mode == "autonomous" {
            if risk == "high" {
                return PermissionDecision {
                    action: PermissionAction::Ask,
                    reason: "高风险操作".into(),
                    source: "mode",
                };
            }
            return PermissionDecision {
                action: PermissionAction::Allow,
                reason: "自主模式".into(),
                source: "mode",
            };
        }
        PermissionDecision {
            action: PermissionAction::Ask,
            reason: "需要你确认".into(),
            source: "mode",
        }
    }

    fn rule_hit(&self, tool_id: &str, target: &str, kind: &str) -> Option<String> {
        if target.is_empty() {
            return None;
        }
        let cfg = self.permissions();
        let patterns = cfg
            .get("tool_rules")
            .and_then(Value::as_object)
            .and_then(|m| m.get(tool_id))
            .and_then(Value::as_object)
            .and_then(|m| m.get(kind))
            .and_then(Value::as_array)?;
        for pattern in patterns.iter().filter_map(Value::as_str) {
            if wildcard_match(pattern, target) || wildcard_match(pattern, target.trim_start_matches("./")) {
                return Some(pattern.to_owned());
            }
        }
        None
    }
}

pub(crate) fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            mark = ti;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod permission_tests {
    use super::{wildcard_match, PermissionAction, SettingsStore};
    use serde_json::json;
    use std::fs;

    #[test]
    fn glob_rules_match_paths_and_commands() {
        assert!(wildcard_match("src/*", "src/main.rs"));
        assert!(wildcard_match("npm test*", "npm test -- --runInBand"));
        assert!(!wildcard_match("secrets/*", "src/main.rs"));
    }

    #[test]
    fn settings_roundtrip_recent_and_permissions_without_bridge() {
        let root = std::env::temp_dir().join(format!("diffusion-native-settings-{}", crate::core::id::unique_id("")));
        fs::create_dir_all(&root).unwrap();
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let store = SettingsStore::new(&root);

        let recent = store.touch_recent(&project).unwrap();
        assert_eq!(recent.len(), 1);
        assert!(recent[0].as_str().unwrap().contains("project"));

        let saf = json!({"kind":"saf","uri":"content://com.example.documents/tree/project","name":"手机项目"});
        let recent = store.touch_recent_location(&saf).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["kind"], "saf");
        assert_eq!(recent[0]["uri"], "content://com.example.documents/tree/project");
        let renamed = json!({"kind":"saf","uri":"content://com.example.documents/tree/project","name":"同一个项目的新名称"});
        let recent = store.touch_recent_location(&renamed).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["name"], "同一个项目的新名称");
        let recent = store.remove_recent_value(&saf).unwrap();
        assert_eq!(recent.len(), 1);
        assert!(recent[0].as_str().unwrap().contains("project"));

        store.update_permissions(&json!({
            "mode":"autonomous",
            "tool_settings":{"fs_delete":"deny","fs_write":"always"},
            "tool_rules":{"shell_run":{"deny":["rm *"],"allow":["cargo test*"]}}
        })).unwrap();

        assert_eq!(store.permissions()["mode"], "autonomous");
        assert_eq!(
            store.evaluate_tool("fs_delete","delete","medium","src/main.rs",false).action,
            PermissionAction::Deny
        );
        assert_eq!(
            store.evaluate_tool("fs_write","write","medium","src/main.rs",false).action,
            PermissionAction::Allow
        );
        assert_eq!(
            store.evaluate_tool("shell_run","exec","medium","rm -rf target",false).action,
            PermissionAction::Deny
        );
        let _ = fs::remove_dir_all(root);
    }
}
