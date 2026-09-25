mod agent;
mod checkpoint;
mod conversation;
mod crypto;
mod id;
mod policy;
mod provider;
mod trash;
mod workspace;

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use agent::AgentState;
use conversation::ConversationStore;
use provider::{list_models, presets, test_profile, ProfileStore};
use workspace::{browse_location, Workspace};

pub const VERSION: &str = "0.8.0-alpha.5";

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeError {
    pub code: String,
    pub message: String,
    pub data: Value,
}

impl RuntimeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: json!({}),
        }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }
}

#[derive(Clone, Serialize)]
struct RuntimeEvent<'a> {
    event: &'a str,
    data: Value,
}

pub struct NativeCore {
    data_dir: PathBuf,
    workspace: Option<Workspace>,
    conversations: Option<ConversationStore>,
    profiles: ProfileStore,
    agent: AgentState,
}

impl NativeCore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            profiles: ProfileStore::new(data_dir.clone()),
            agent: AgentState::new(),
            data_dir,
            workspace: None,
            conversations: None,
        }
    }

    fn emit(app: &AppHandle, event: &str, data: Value) {
        let _ = app.emit("diffusion://event", RuntimeEvent { event, data });
    }

    fn ws(&self) -> Result<&Workspace, RuntimeError> {
        self.workspace
            .as_ref()
            .ok_or_else(|| RuntimeError::new("NO_WORKSPACE", "请先打开一个项目文件夹"))
    }

    fn conversations(&self) -> Result<&ConversationStore, RuntimeError> {
        self.conversations
            .as_ref()
            .ok_or_else(|| RuntimeError::new("NO_WORKSPACE", "请先打开一个项目文件夹"))
    }

    pub fn call(
        &mut self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, RuntimeError> {
        match method {
            "hello" => Ok(self.hello()),
            "profiles.list" => Ok(json!({"profiles": self.profiles.list_public()})),
            "profiles.save" => {
                let profile = params.get("profile").ok_or_else(|| RuntimeError::new("BAD_PROFILE", "缺少 profile"))?;
                let saved = self.profiles.save(profile, params.get("api_key").and_then(Value::as_str))?;
                Self::emit(app, "profiles.changed", json!({"profiles": self.profiles.list_public()}));
                Ok(saved)
            }
            "profiles.delete" => {
                self.profiles.delete(req_str(&params, "id")?)?;
                Self::emit(app, "profiles.changed", json!({"profiles": self.profiles.list_public()}));
                Ok(json!({}))
            }
            "profiles.models" => {
                let (profile, key) = self.profiles.resolve(
                    params.get("id").and_then(Value::as_str),
                    params.get("profile"),
                    params.get("api_key").and_then(Value::as_str),
                )?;
                Ok(json!({"models": list_models(&profile, key.as_deref())?}))
            }
            "profiles.test" => {
                let (profile, key) = self.profiles.get(req_str(&params, "id")?)?;
                Ok(json!({"ok": true, "reply": test_profile(&profile, key.as_deref())?}))
            }
            "conv.list" => Ok(json!({"conversations": self.conversations()?.list()?})),
            "conv.get" => self.conversations()?.get(req_str(&params, "id")?),
            "conv.delete" => {
                self.conversations()?.delete(req_str(&params, "id")?)?;
                Ok(json!({}))
            }
            "conversation.compact" => Err(RuntimeError::new(
                "MIGRATION_PENDING",
                "Native 对话压缩还在迁移中",
            )),
            "agent.start" => {
                let mode = params.get("mode").and_then(Value::as_str).unwrap_or("chat");
                if !matches!(mode, "chat" | "read") {
                    return Err(RuntimeError::new(
                        "MIGRATION_PENDING",
                        format!("Native Core 的「{mode}」模式仍在迁移；alpha.5 当前开放聊天和只读模式"),
                    )
                    .with_data(json!({"mode": mode, "available_modes": ["chat", "read"]})));
                }
                let goal = req_str(&params, "goal")?.to_owned();
                let profile_id = req_str(&params, "profile")?.to_owned();
                let reasoning = params
                    .get("reasoning")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .to_owned();
                let conversation_id = params
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let (profile, key) = self.profiles.get(&profile_id)?;
                let store = self.conversations()?.clone();
                let workspace_root = self.ws()?.root_path();
                self.agent.start(
                    app.clone(),
                    store,
                    profile,
                    key,
                    goal,
                    conversation_id,
                    reasoning,
                    mode.to_owned(),
                    workspace_root,
                )
            }
            "agent.stop" => Ok(json!({"stopped": self.agent.stop()})),
            "workspace.open" => {
                let path = req_str(&params, "path")?;
                let ws = Workspace::open(path, &self.data_dir)?;
                let info = ws.info();
                let conversations = ConversationStore::new(
                    self.data_dir.join("conversations").join(ws.storage_key())
                )?;
                self.workspace = Some(ws);
                self.conversations = Some(conversations);
                Self::emit(app, "workspace.opened", info.clone());
                Ok(info)
            }
            "workspace.close" => {
                let _ = self.agent.stop();
                self.workspace = None;
                self.conversations = None;
                Self::emit(app, "workspace.closed", json!({}));
                Ok(json!({}))
            }
            "workspace.browse" => browse_location(params.get("path").and_then(Value::as_str), Some(&self.data_dir)),
            "workspace.remove_recent" => Ok(json!({})),
            "fs.read" => self.ws()?.read(req_str(&params, "path")?),
            "fs.hash" => self.ws()?.hash(req_str(&params, "path")?),
            "fs.tree" => self.ws()?.tree(
                params.get("path").and_then(Value::as_str).unwrap_or("."),
                params
                    .get("depth")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .clamp(1, 8) as usize,
                params
                    .get("show_hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
            "fs.search" => self.ws()?.search(
                req_str(&params, "query")?,
                params
                    .get("case_sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                params
                    .get("max_results")
                    .and_then(Value::as_u64)
                    .unwrap_or(200)
                    .clamp(1, 1000) as usize,
            ),
            "fs.write" => {
                let change = self.ws()?.write_text(
                    req_str(&params, "path")?,
                    req_str(&params, "content")?,
                    params.get("base_revision").and_then(Value::as_str),
                )?;
                if change.changed {
                    Self::emit(app, "fs.changed", change.event.clone());
                }
                Ok(change.result)
            }
            "fs.patch" => {
                let edits = params
                    .get("edits")
                    .and_then(Value::as_array)
                    .ok_or_else(|| RuntimeError::new("BAD_EDIT", "edits 必须是数组"))?;
                let change = self.ws()?.patch(
                    req_str(&params, "path")?,
                    req_str(&params, "base_revision")?,
                    edits,
                )?;
                if change.changed {
                    Self::emit(app, "fs.changed", change.event.clone());
                }
                Ok(change.result)
            }
            "fs.create" => {
                let change = self.ws()?.create(
                    req_str(&params, "path")?,
                    params.get("kind").and_then(Value::as_str).unwrap_or("file"),
                    params.get("content").and_then(Value::as_str).unwrap_or(""),
                )?;
                Self::emit(app, "fs.changed", change.event.clone());
                Ok(change.result)
            }
            "fs.rename" => {
                let change = self
                    .ws()?
                    .rename(req_str(&params, "from")?, req_str(&params, "to")?)?;
                Self::emit(app, "fs.changed", change.event.clone());
                Ok(change.result)
            }
            "fs.copy" => {
                let result = self
                    .ws()?
                    .copy(req_str(&params, "from")?, req_str(&params, "to")?)?;
                Self::emit(
                    app,
                    "fs.external",
                    json!({"changes": [{"path": result["path"], "kind":"create"}]}),
                );
                Ok(result)
            }
            "fs.begin_write" => self.ws()?.begin_write(
                req_str(&params, "path")?,
                params.get("base_revision").and_then(Value::as_str),
            ),
            "fs.write_chunk" => self.ws()?.write_chunk(
                req_str(&params, "write_id")?,
                params.get("seq").and_then(Value::as_u64).unwrap_or(0) as usize,
                req_str(&params, "data")?,
                params
                    .get("encoding")
                    .and_then(Value::as_str)
                    .unwrap_or("utf-8"),
            ),
            "fs.commit_write" => {
                let change = self.ws()?.commit_write(
                    req_str(&params, "write_id")?,
                    params
                        .get("total_bytes")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "缺少 total_bytes"))?
                        as usize,
                    req_str(&params, "sha256")?,
                )?;
                if change.changed {
                    Self::emit(app, "fs.changed", change.event.clone());
                }
                Ok(change.result)
            }
            "fs.abort_write" => self.ws()?.abort_write(req_str(&params, "write_id")?),
            "fs.delete" => {
                let change = self.ws()?.delete(req_str(&params, "path")?)?;
                Self::emit(app, "fs.changed", change.event.clone());
                Ok(change.result)
            }
            "trash.list" => Ok(json!({"items": self.ws()?.trash_list()?})),
            "trash.restore" => {
                let change = self.ws()?.restore_from_trash(req_str(&params, "id")?)?;
                Self::emit(app, "fs.changed", change.event.clone());
                Ok(change.result)
            }
            "trash.delete" => {
                self.ws()?.trash_delete(req_str(&params, "id")?)?;
                Ok(json!({}))
            }
            "trash.empty" => Ok(json!({"removed": self.ws()?.trash_empty()?})),
            "checkpoint.tasks" => Ok(json!({"tasks": self.ws()?.checkpoint_tasks(50)?})),
            "checkpoint.task" => self.ws()?.checkpoint_task(req_str(&params, "task_id")?),
            "checkpoint.diff" => self.ws()?.checkpoint_diff(
                req_str(&params, "task_id")?,
                params.get("seq").and_then(Value::as_u64).unwrap_or(0) as usize,
            ),
            "checkpoint.revert_file" => {
                let batch = self.ws()?.checkpoint_revert_file(
                    req_str(&params, "task_id")?,
                    req_str(&params, "path")?,
                )?;
                for event in batch.events {
                    Self::emit(app, "fs.changed", event);
                }
                Ok(batch.result)
            }
            "checkpoint.revert_task" => {
                let batch = self
                    .ws()?
                    .checkpoint_revert_task(req_str(&params, "task_id")?)?;
                for event in batch.events {
                    Self::emit(app, "fs.changed", event);
                }
                Ok(batch.result)
            }
            "checkpoint.revert_event" => {
                let batch = self.ws()?.checkpoint_revert_event(
                    req_str(&params, "task_id")?,
                    params.get("seq").and_then(Value::as_u64).unwrap_or(0) as usize,
                    params
                        .get("force")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?;
                for event in batch.events {
                    Self::emit(app, "fs.changed", event);
                }
                Ok(batch.result)
            }
            "git.status" => Ok(json!({"is_repo": false, "files": [], "branch": null})),
            _ => Err(RuntimeError::new(
                "METHOD_NOT_IMPLEMENTED",
                format!("Native Core 尚未迁移方法：{method}"),
            )
            .with_data(json!({"method": method}))),
        }
    }

    fn hello(&self) -> Value {
        json!({
            "version": VERSION,
            "platform": std::env::consts::OS,
            "native": true,
            "lan": false,
            "workspace": self.workspace.as_ref().map(Workspace::info),
            "permissions": {
                "mode": "manual",
                "modes": ["strict", "manual", "ai", "autonomous"],
                "tool_settings_options": []
            },
            "profiles": self.profiles.list_public(),
            "presets": presets(),
            "agent": {"running": self.agent.is_running(), "task_id": self.agent.task_id()},
            "agent_modes": ["chat", "read"],
            "approvals": [],
            "questions": [],
            "tools": [],
            "recent": [],
            "native_migration": {
                "phase": "D-readonly",
                "implemented": ["hello", "workspace.open", "workspace.close", "workspace.browse", "fs.read", "fs.hash", "fs.tree", "fs.search", "fs.write", "fs.patch", "fs.create", "fs.delete", "fs.rename", "fs.copy", "fs.begin_write", "fs.write_chunk", "fs.commit_write", "fs.abort_write", "trash.list", "trash.restore", "trash.delete", "trash.empty", "checkpoint.tasks", "checkpoint.task", "checkpoint.diff", "checkpoint.revert_file", "checkpoint.revert_task", "checkpoint.revert_event", "profiles.list", "profiles.save", "profiles.delete", "profiles.models", "profiles.test", "conv.list", "conv.get", "conv.delete", "agent.start(chat/read)", "agent.stop", "agent.fs_list", "agent.fs_read", "agent.fs_search", "hard_policy.read"]
            },
            "data_dir": self.data_dir
        })
    }
}

fn req_str<'a>(v: &'a Value, key: &str) -> Result<&'a str, RuntimeError> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_REQUEST", format!("缺少字符串参数：{key}")))
}
