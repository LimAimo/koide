mod agent;
mod checkpoint;
mod conversation;
mod crypto;
mod devices;
mod git;
mod id;
mod instructions;
mod policy;
mod provider;
mod settings;
mod terminal;
mod trash;
mod watcher;
mod workspace;
mod studio;
mod preview;

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use agent::{AgentLimits, AgentState};
use conversation::ConversationStore;
use devices::DeviceStore;
use git as gitops;
use settings::{tool_descriptions, SettingsStore};
use terminal::{listening_ports, TerminalManager};
use provider::{chat_complete, list_models, presets, test_profile, ProfileStore};
use watcher::WorkspaceWatcher;
use workspace::{browse_location, Workspace};

pub const VERSION: &str = "0.11.0";

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
    devices: DeviceStore,
    profiles: ProfileStore,
    settings: SettingsStore,
    terminal: TerminalManager,
    agent: AgentState,
    watcher: Option<WorkspaceWatcher>,
    preview: preview::PreviewManager,
}

impl NativeCore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            profiles: ProfileStore::new(data_dir.clone()),
            devices: DeviceStore::new(&data_dir),
            settings: SettingsStore::new(&data_dir),
            terminal: TerminalManager::new(),
            agent: AgentState::new(),
            watcher: None,
            preview: preview::PreviewManager::new(data_dir.clone()),
            data_dir,
            workspace: None,
            conversations: None,
        }
    }

    fn emit(app: &AppHandle, event: &str, data: Value) {
        let _ = app.emit("diffusion://event", RuntimeEvent { event, data });
    }

    pub fn stop_handle(&self) -> std::sync::Arc<dyn Fn() -> Result<Value, RuntimeError> + Send + Sync> {
        let agent = self.agent.clone();
        std::sync::Arc::new(move || Ok(json!({"stopped":agent.stop()})))
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

    fn local_workspace_root(&self, feature: &str) -> Result<PathBuf, RuntimeError> {
        self.ws()?.local_root_path().ok_or_else(|| RuntimeError::new(
            "WORKSPACE_CAPABILITY",
            format!("当前 Android SAF 工作区不提供 {feature} 的 POSIX 路径能力"),
        ).with_data(json!({"feature":feature,"workspace_backend":"saf"})))
    }

    pub fn call(
        &mut self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, RuntimeError> {
        if params.get("workspace_key").is_some() {
            let current = self.workspace.as_ref().map(Workspace::storage_key);
            check_workspace_key(current.as_deref(), &params)?;
        }
        match method {
            "hello" => Ok(self.hello()),
            "studio.read" => studio::read(self.ws()?),
            "studio.revision" => studio::revision(self.ws()?),
            "studio.write" => {
                let data = params.get("data").ok_or_else(||RuntimeError::new("BAD_REQUEST","缺少工作台数据"))?;
                let (result, events) = studio::write(self.ws()?,data,params.get("base_revision").and_then(Value::as_str))?;
                for event in events { Self::emit(app,"fs.changed",event); }
                Ok(result)
            },
            "studio.apply_edits" => {
                if self.agent.is_running() {return Err(RuntimeError::new("AGENT_BUSY","先停止 AI 任务再重命名符号"));}
                let files = params.get("files").and_then(Value::as_array).ok_or_else(||RuntimeError::new("BAD_EDIT","files 必须是数组"))?;
                let (result, events) = self.ws()?.apply_text_edits(files,params.get("label").and_then(Value::as_str).unwrap_or("语言服务重命名"))?;
                for event in events { Self::emit(app,"fs.changed",event); }
                Ok(result)
            },
            "launch.inspect" => studio::inspect_launch(self.ws()?),
            "experiments.list" => studio::experiments_list(self.ws()?),
            "experiments.create" => {
                let (result, events) = studio::experiments_create_from(self.ws()?,req_str(&params,"name")?,params.get("baseline_id").and_then(Value::as_str))?;
                for event in events { Self::emit(app,"fs.changed",event); } Ok(result)
            },
            "experiments.diff" => studio::experiments_diff(self.ws()?,req_str(&params,"id")?),
            "experiments.apply" => {
                if self.agent.is_running() {return Err(RuntimeError::new("AGENT_BUSY","先停止 AI 任务再应用方案"));}
                let (result, events) = studio::experiments_apply(self.ws()?,req_str(&params,"id")?)?;
                for event in events { Self::emit(app,"fs.changed",event); } Ok(result)
            },
            "preview.open" => { self.ws()?; self.preview.open(req_str(&params,"url")?) },
            "preview.close" => self.preview.close(req_str(&params,"id")?),
            "preview.capture" => self.preview.capture(req_str(&params,"id")?,params.get("width").and_then(Value::as_u64).unwrap_or(1280),params.get("height").and_then(Value::as_u64).unwrap_or(800)),
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
                if !matches!(mode, "chat" | "read" | "edit" | "agent") {
                    return Err(RuntimeError::new(
                        "MIGRATION_PENDING",
                        format!("Native Core 不支持未知模式「{mode}」"),
                    )
                    .with_data(json!({"mode": mode, "available_modes": ["chat", "read", "edit", "agent"]})));
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
                let workspace = self.ws()?.clone();
                let checkpoints = workspace.checkpoint_handle();
                let project_instructions = workspace.project_instructions();
                let system_context = instructions::agent_context_with_project(&self.data_dir, Some(&project_instructions));
                if let Some(raw) = params.get("limits") {
                    if !raw.is_object() {
                        return Err(RuntimeError::new("BAD_BUDGET", "任务限制必须是对象"));
                    }
                    for field in ["max_tool_calls", "max_seconds", "max_repair_attempts", "max_tokens", "max_repeated_failures"] {
                        if raw.get(field).is_some_and(|v| v.as_u64().is_none()) {
                            return Err(RuntimeError::new("BAD_BUDGET", "任务次数和 Token 上限必须是非负整数"));
                        }
                    }
                    if raw.get("max_cost_usd").is_some_and(|v| v.as_f64().map_or(true, |n| !n.is_finite() || n < 0.0)) {
                        return Err(RuntimeError::new("BAD_BUDGET", "费用上限必须是非负有限数值"));
                    }
                }
                let limits = AgentLimits::from_params(
                    params.get("limits"),
                    params.get("web_search").and_then(Value::as_bool).unwrap_or(false),
                );
                let attachments = match params.get("attachments") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::Array(images)) => images.clone(),
                    _ => return Err(RuntimeError::new("BAD_ATTACHMENT", "参考图附件必须是数组")),
                };
                let attachments = crate::core::agent::validate_start(&profile, &attachments, &limits)?;
                if let Some(id) = conversation_id.as_deref() {
                    crate::core::provider::ensure_vision(&profile, &store.messages(id)?)?;
                }
                let checkpoint_task = checkpoints.start_task(&goal, mode)?;
                let task_id = checkpoint_task
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT", "新建任务缺少 id"))?
                    .to_owned();
                self.agent.start_with_attachments(
                    app.clone(),
                    store,
                    profile,
                    key,
                    goal,
                    conversation_id,
                    reasoning,
                    mode.to_owned(),
                    system_context,
                    workspace,
                    self.data_dir.clone(),
                    task_id,
                    checkpoints,
                    self.terminal.clone(),
                    limits,
                    attachments,
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
            "permissions.set" => {
                let updated = self.settings.update_permissions(&params)?;
                Self::emit(app, "permissions.changed", updated.clone());
                Ok(updated)
            }
            "instructions.constitution" => Ok(json!({"text": instructions::AIMO_CONSTITUTION})),
            "instructions.get" => {
                let project = self.workspace.as_ref().map(Workspace::project_instructions).unwrap_or_default();
                Ok(instructions::get_with_project(&self.data_dir, Some(&project)))
            },
            "instructions.set" => {
                instructions::set_global(
                    &self.data_dir,
                    params.get("global").and_then(Value::as_str).unwrap_or(""),
                )?;
                Ok(json!({}))
            }
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
                if self.agent.is_running() { return Err(RuntimeError::new("AGENT_BUSY", "先停止当前 AI 任务，再切换项目")); }
                let mut location = params.get("location").cloned().or_else(|| {
                    params.get("path").and_then(Value::as_str).map(|path| Value::String(path.to_owned()))
                }).ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "缺少工作区位置"))?;
                if location.get("kind").and_then(Value::as_str) == Some("saf")
                    && location.get("pick").and_then(Value::as_bool) == Some(true)
                {
                    location = Workspace::pick_saf(app)?;
                }
                let ws = Workspace::open_location(app, &location, &self.data_dir)?;
                self.preview.close_all();
                self.terminal.close_all();
                if let Some(watcher) = self.watcher.take() { watcher.stop(); }
                let info = ws.info();
                let canonical_location = ws.location();
                let conversations = ConversationStore::new(
                    self.data_dir.join("conversations").join(ws.storage_key())
                )?;
                let recent = self.settings.touch_recent_location(&canonical_location)?;
                let local_root = ws.local_root_path();
                self.workspace = Some(ws);
                self.conversations = Some(conversations);
                self.watcher = local_root.map(|root| WorkspaceWatcher::start(app.clone(), root)).transpose()?;
                Self::emit(app, "workspace.opened", info.clone());
                Self::emit(app, "workspace.recent_changed", json!({"recent": recent}));
                Ok(info)
            }
            "workspace.close" => {
                self.preview.close_all();
                let _ = self.agent.stop();
                self.terminal.close_all();
                if let Some(watcher) = self.watcher.take() { watcher.stop(); }
                self.workspace = None;
                self.conversations = None;
                Self::emit(app, "workspace.closed", json!({}));
                Ok(json!({}))
            }
            "workspace.browse" => browse_location(params.get("path").and_then(Value::as_str), Some(&self.data_dir)),
            "workspace.remove_recent" => {
                let target = params.get("location").or_else(|| params.get("path"))
                    .ok_or_else(|| RuntimeError::new("BAD_WORKSPACE", "缺少最近项目位置"))?;
                let recent = self.settings.remove_recent_value(target)?;
                Self::emit(app, "workspace.recent_changed", json!({"recent": recent}));
                Ok(json!({"recent": recent}))
            },
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
            "fs.export" => self.ws()?.export_zip(
                params.get("path").and_then(Value::as_str).unwrap_or("."),
                &self.data_dir,
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
            "terminal.run" => {
                let command = req_str(&params, "command")?;
                if let Some(verdict) = policy::check_command(command) {
                    if verdict.action == policy::CommandPolicyAction::Deny {
                        return Err(RuntimeError::new("POLICY_DENIED", verdict.reason));
                    }
                }
                let raw_cwd = match params.get("cwd") {
                    None | Some(Value::Null) => ".",
                    Some(Value::String(path)) => path.as_str(),
                    _ => return Err(RuntimeError::new("BAD_PATH", "命令工作目录必须是路径字符串")),
                };
                let cwd = self.ws()?.terminal_directory(raw_cwd)?;
                self.terminal.run(app, &cwd, command,
                    params.get("timeout_seconds").and_then(Value::as_f64).unwrap_or(600.0))
            },
            "terminal.kill" => self.terminal.kill(req_str(&params, "id")?),
            "terminal.open" => self.terminal.open(
                app,
                &self.local_workspace_root("终端")?,
                params.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(20, 500) as u16,
                params.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(8, 300) as u16,
            ),
            "terminal.input" => self.terminal.input(
                req_str(&params, "id")?,
                params.get("data").and_then(Value::as_str).unwrap_or(""),
            ),
            "terminal.resize" => self.terminal.resize(
                req_str(&params, "id")?,
                params.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(20, 500) as u16,
                params.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(8, 300) as u16,
            ),
            "terminal.close" => self.terminal.close(req_str(&params, "id")?),
            "terminal.list" => Ok(self.terminal.list()),
            "terminal.history" => self.terminal.history(req_str(&params, "id")?),
            "ports.list" => Ok(json!({"ports": listening_ports()})),
            "devices.pair_code" => Err(RuntimeError::new(
                "LAN_OFF",
                "Native Remote Runtime 尚未启用；本机 Native 模式不需要配对。"
            )),
            "devices.list" => Ok(json!({"devices": self.devices.list()})),
            "devices.revoke" => Ok(json!({"revoked": self.devices.revoke(req_str(&params, "id")?)?})),
            "git.status" => gitops::status(&self.local_workspace_root("Git")?),
            "git.diff" => gitops::diff(
                &self.local_workspace_root("Git")?,
                req_str(&params, "path")?,
                params.get("staged").and_then(Value::as_bool).unwrap_or(false),
            ),
            "git.stage" => {
                let paths = params.get("paths").and_then(Value::as_array)
                    .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "paths 必须是数组"))?
                    .iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
                let result = gitops::stage(&self.local_workspace_root("Git")?, &paths)?;
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.unstage" => {
                let paths = params.get("paths").and_then(Value::as_array)
                    .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "paths 必须是数组"))?
                    .iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
                let result = gitops::unstage(&self.local_workspace_root("Git")?, &paths)?;
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
                let result = gitops::commit(&self.local_workspace_root("Git")?, req_str(&params, "message")?)?;
                Self::emit(app, "git.changed", json!({}));
                Ok(result)
            }
            "git.branches" => gitops::branches(&self.local_workspace_root("Git")?),
            "git.checkout" => {
                let result = gitops::checkout(
                    &self.local_workspace_root("Git")?,
                    req_str(&params, "name")?,
                    params.get("create").and_then(Value::as_bool).unwrap_or(false),
                )?;
                Self::emit(app, "git.changed", json!({}));
                Self::emit(app, "fs.external", json!({"changes":[{"path":".","kind":"modify"}]}));
                Ok(result)
            }
            "git.log" => gitops::log(
                &self.local_workspace_root("Git")?,
                params.get("limit").and_then(Value::as_u64).unwrap_or(50),
                params.get("path").and_then(Value::as_str),
            ),
            "git.blame" => gitops::blame(&self.local_workspace_root("Git")?, req_str(&params, "path")?),
            "git.pull" => {
                let result = gitops::pull(&self.local_workspace_root("Git")?)?;
                Self::emit(app, "git.changed", json!({}));
                Self::emit(app, "fs.external", json!({"changes":[{"path":".","kind":"modify"}]}));
                Ok(result)
            }
            "git.push" => gitops::push(&self.local_workspace_root("Git")?),
            "git.init" => {
                let result = gitops::init(&self.local_workspace_root("Git")?)?;
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
        let mut permissions = self.settings.permissions();
        if let Some(obj) = permissions.as_object_mut() {
            obj.insert("modes".into(), json!(["restricted", "manual", "ai", "autonomous"]));
            obj.insert("tool_settings_options".into(), json!(["deny", "ask", "session", "always", "ai_review"]));
        }
        json!({
            "version": VERSION,
            "platform": std::env::consts::OS,
            "native": true,
            "lan": false,
            "workspace": self.workspace.as_ref().map(Workspace::info),
            "permissions": permissions,
            "profiles": self.profiles.list_public(),
            "presets": presets(),
            "agent": {"running": self.agent.is_running(), "task_id": self.agent.task_id()},
            "agent_modes": ["chat", "read", "edit", "agent"],
            "approvals": self.agent.pending_approvals(),
            "questions": self.agent.pending_questions(),
            "tools": tool_descriptions(),
            "recent": self.settings.recent(),
            "approval_profile": self.settings.approval_profile(),
            "native_migration": {
                "phase": "parity-audit",
                "runtime_dispatch": "84/84",
                "implemented": ["conversation.compact","studio.read","preview.open"],
                "python_bridge_removal_allowed": false,
                "capabilities": {
                    "workspace_path_backend": true,
                    "workspace_android_saf": true,
                    "filesystem": true,
                    "external_watcher": true,
                    "export_zip": true,
                    "trash": true,
                    "checkpoint": true,
                    "git": true,
                    "providers": true,
                    "provider_streaming": true,
                    "agent_modes": ["chat","read","edit","agent"],
                    "agent_shell": true,
                    "agent_network": true,
                    "permissions": true,
                    "instructions": true,
                    "terminal_one_shot": true,
                    "terminal_interactive_pty": cfg!(not(target_os = "android")),
                    "remote_runtime_server": false,
                    "device_store": true
                },
                "blockers_before_python_removal": [
                    "Native Remote Runtime server 尚未实现；devices.pair_code 当前明确返回 LAN_OFF",
                    "Android 交互式 PTY 尚未实现",
                    "Native-only parity/smoke gate 尚需最终通过"
                ]
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

fn check_workspace_key(current: Option<&str>, params: &Value) -> Result<(), RuntimeError> {
    let Some(value) = params.get("workspace_key") else { return Ok(()); };
    let requested = value.as_str().filter(|key| !key.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_REQUEST", "workspace_key 必须是非空字符串"))?;
    if current != Some(requested) {
        return Err(RuntimeError::new("WORKSPACE_CHANGED", "项目已经切换，请刷新后重试"));
    }
    Ok(())
}

#[cfg(test)]
mod workspace_dispatch_tests {
    use super::*;
    #[test]
    fn queued_request_cannot_target_another_or_closed_workspace() {
        let queued = json!({"workspace_key":"project-a","base_revision":"absent"});
        assert!(check_workspace_key(Some("project-a"), &queued).is_ok());
        assert_eq!(check_workspace_key(Some("project-b"), &queued).unwrap_err().code, "WORKSPACE_CHANGED");
        assert_eq!(check_workspace_key(None, &queued).unwrap_err().code, "WORKSPACE_CHANGED");
        assert!(check_workspace_key(None, &json!({})).is_ok());
        assert_eq!(check_workspace_key(None, &json!({"workspace_key":false})).unwrap_err().code, "BAD_REQUEST");
    }
}
