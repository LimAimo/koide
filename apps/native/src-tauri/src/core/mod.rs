mod agent;
mod checkpoint;
mod conversation;
mod crypto;
mod git;
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
use git as gitops;
use provider::{chat_complete, list_models, presets, test_profile, ProfileStore};
use workspace::{browse_location, Workspace};

pub const VERSION: &str = "0.8.0-alpha.7";

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
            "conversation.compact" => {
                let conversation_id = req_str(&params, "conversation_id")?;
                let profile_id = params.get("profile").and_then(Value::as_str).map(str::to_owned)
                    .or_else(|| self.profiles.list_public().first().and_then(|p| p.get("id")).and_then(Value::as_str).map(str::to_owned))
                    .ok_or_else(|| RuntimeError::new("NO_PROFILE", "请先添加一个模型服务商"))?;
                let (profile, key) = self.profiles.get(&profile_id)?;
                let messages = self.conversations()?.messages(conversation_id)?;
                if messages.is_empty() {
                    return Err(RuntimeError::new("EMPTY_CONVERSATION", "当前会话没有可压缩的内容"));
                }
                let transcript = messages.iter().filter_map(|m| {
                    let role = m.get("role").and_then(Value::as_str)?;
                    let content = m.get("content").and_then(Value::as_str)?;
                    Some(format!("{role}: {content}"))
                }).collect::<Vec<_>>().join("\n\n");
                let summary = chat_complete(
                    &profile,
                    key.as_deref(),
                    &[
                        json!({"role":"system","content":"Summarize the conversation for future continuation inside a coding IDE. Preserve decisions, file names, constraints, unresolved tasks, and important technical facts. Be compact but loss-minimizing. Do not add facts."}),
                        json!({"role":"user","content":transcript})
                    ],
                    "off",
                )?;
                self.conversations()?.append_compact(conversation_id, &summary)?;
                Ok(json!({"summary":summary}))
            },
            "agent.start" => {
                if self.agent.is_running() {
                    return Err(RuntimeError::new("AGENT_BUSY", "已有一个 AI 任务正在运行"));
                }
                let mode = params.get("mode").and_then(Value::as_str).unwrap_or("chat");
                if !matches!(mode, "chat" | "read" | "edit") {
                    return Err(RuntimeError::new(
                        "MIGRATION_PENDING",
                        format!("Native Core 的「{mode}」模式仍在迁移；当前开放聊天、只读和编辑模式"),
                    )
                    .with_data(json!({"mode": mode, "available_modes": ["chat", "read", "edit"]})));
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
                let checkpoints = self.ws()?.checkpoint_handle();
                let checkpoint_task = checkpoints.start_task(&goal, mode)?;
                let task_id = checkpoint_task
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "新建任务缺少 id"))?
                    .to_owned();
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
                    self.data_dir.clone(),
                    task_id,
                    checkpoints,
                )
            }
            "agent.stop" => Ok(json!({"stopped": self.agent.stop()})),
            "agent.answer" => {
                let answers = params.get("answers").and_then(Value::as_array)
                    .map(|xs| xs.iter().map(|v| v.as_str().unwrap_or("").to_owned()).collect::<Vec<_>>())
                    .or_else(|| params.get("answer").and_then(Value::as_str).map(|s| vec![s.to_owned()]))
                    .unwrap_or_default();
                let result = self.agent.answer_question(req_str(&params, "question_id")?, answers)?;
                Self::emit(app, "agent.question_resolved", result.clone());
                Ok(result)
            },
            "approval.respond" => {
                let result = self.agent.respond_approval(
                    req_str(&params, "approval_id")?,
                    params.get("allow").and_then(Value::as_bool).unwrap_or(false),
                    params.get("scope").and_then(Value::as_str).unwrap_or("once"),
                )?;
                Self::emit(app, "approval.resolved", result.clone());
                Ok(result)
            },
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
            "git.status" => gitops::status(&self.ws()?.root_path()),
            "git.diff" => gitops::diff(
                &self.ws()?.root_path(),
                req_str(&params, "path")?,
                params.get("staged").and_then(Value::as_bool).unwrap_or(false),
            ),
            "git.stage" => {
                let paths = params.get("paths").and_then(Value::as_array)
                    .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "paths 必须是数组"))?
                    .iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
                let result = gitops::stage(&self.ws()?.root_path(), &paths)?;
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.unstage" => {
                let paths = params.get("paths").and_then(Value::as_array)
                    .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "paths 必须是数组"))?
                    .iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
                let result = gitops::unstage(&self.ws()?.root_path(), &paths)?;
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.discard" => {
                let (result, events) = gitops::discard(
                    self.ws()?,
                    req_str(&params, "path")?,
                    params.get("confirm").and_then(Value::as_bool).unwrap_or(false),
                )?;
                for event in events { Self::emit(app, "fs.changed", event); }
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.reset" => {
                let (result, events) = gitops::reset(
                    self.ws()?,
                    req_str(&params, "hash")?,
                    params.get("mode").and_then(Value::as_str).unwrap_or("soft"),
                    params.get("confirm").and_then(Value::as_bool).unwrap_or(false),
                )?;
                for event in events { Self::emit(app, "fs.changed", event); }
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.commit" => {
                let result = gitops::commit(&self.ws()?.root_path(), req_str(&params, "message")?)?;
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.branches" => gitops::branches(&self.ws()?.root_path()),
            "git.checkout" => {
                let result = gitops::checkout(
                    &self.ws()?.root_path(),
                    req_str(&params, "name")?,
                    params.get("create").and_then(Value::as_bool).unwrap_or(false),
                )?;
                Self::emit(app, "git.changed", json!({}));
                Self::emit(app, "fs.external", json!({"changes":[{"path":".","kind":"modify"}]}));
                Ok(result)
            }
            "git.log" => gitops::log(
                &self.ws()?.root_path(),
                params.get("limit").and_then(Value::as_u64).unwrap_or(50),
                params.get("path").and_then(Value::as_str),
            ),
            "git.blame" => gitops::blame(&self.ws()?.root_path(), req_str(&params, "path")?),
            "git.pull" => {
                let result = gitops::pull(&self.ws()?.root_path())?;
                Self::emit(app, "git.changed", json!({}));
                Self::emit(app, "fs.external", json!({"changes":[{"path":".","kind":"modify"}]}));
                Ok(result)
            }
            "git.push" => gitops::push(&self.ws()?.root_path()),
            "git.init" => {
                let result = gitops::init(&self.ws()?.root_path())?;
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            },
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
            "agent_modes": ["chat", "read", "edit"],
            "approvals": self.agent.pending_approvals(),
            "questions": self.agent.pending_questions(),
            "tools": [],
            "recent": [],
            "native_migration": {
                "phase": "E-edit",
                "implemented": ["hello", "workspace.open", "workspace.close", "workspace.browse", "fs.read", "fs.hash", "fs.tree", "fs.search", "fs.write", "fs.patch", "fs.create", "fs.delete", "fs.rename", "fs.copy", "fs.begin_write", "fs.write_chunk", "fs.commit_write", "fs.abort_write", "trash.list", "trash.restore", "trash.delete", "trash.empty", "checkpoint.tasks", "checkpoint.task", "checkpoint.diff", "checkpoint.revert_file", "checkpoint.revert_task", "checkpoint.revert_event", "profiles.list", "profiles.save", "profiles.delete", "profiles.models", "profiles.test", "conv.list", "conv.get", "conv.delete", "agent.start(chat/read/edit)", "agent.stop", "agent.fs_list", "agent.fs_read", "agent.fs_search", "agent.fs_write", "agent.fs_patch", "agent.fs_create", "agent.fs_delete", "agent.fs_rename", "agent.fs_copy", "hard_policy.read", "hard_policy.write", "approval.respond", "checkpoint.agent_lifecycle", "checkpoint.agent_edits", "agent.answer", "agent.ask_user", "conversation.compact", "git.status", "git.diff", "git.stage", "git.unstage", "git.discard", "git.reset", "git.commit", "git.branches", "git.checkout", "git.log", "git.blame", "git.pull", "git.push", "git.init"]
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
