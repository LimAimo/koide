use crate::core::checkpoint::CheckpointStore;
use crate::core::conversation::ConversationStore;
use crate::core::id::unique_id;
use crate::core::policy::{
    check_command, check_read_path, check_write_path, ensure_public_http_url,
    CommandPolicyAction,
};
use crate::core::provider::{anthropic_stream_turn, chat_complete, gemini_stream_turn, openai_stream_turn, ProfileStore, StreamEvent, ToolCall};
use crate::core::settings::{wildcard_match, PermissionAction, SettingsStore};
use crate::core::terminal::{run_capture, TerminalManager};
use crate::core::workspace::Workspace;
use crate::core::RuntimeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_TOOL_ROUNDS: usize = 12;
const MAX_TOOL_CALLS: usize = 32;
const MAX_AGENT_READ_BYTES: u64 = 8 * 1024 * 1024;

const HARD_MAX_TOOL_CALLS: usize = 128;
const WEB_FETCH_MAX_BYTES: usize = 800_000;
const WEB_FETCH_MAX_CHARS: usize = 20_000;

#[derive(Debug, Clone)]
pub struct AgentLimits {
    pub max_tool_calls: usize,
    pub max_seconds: u64,
    pub max_repair_attempts: usize,
    pub web_search: bool,
}

impl AgentLimits {
    pub fn from_params(limits: Option<&Value>, web_search: bool) -> Self {
        let max_tool_calls = limits
            .and_then(|v| v.get("max_tool_calls"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(HARD_MAX_TOOL_CALLS as u64) as usize;
        let max_seconds = limits
            .and_then(|v| v.get("max_seconds"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(3600);
        let max_repair_attempts = limits
            .and_then(|v| v.get("max_repair_attempts"))
            .and_then(Value::as_u64)
            .unwrap_or(8)
            .clamp(1, 32) as usize;
        Self { max_tool_calls, max_seconds, max_repair_attempts, web_search }
    }
}

#[derive(Clone)]
pub struct AgentState {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    task_id: Arc<Mutex<Option<String>>>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
}

#[derive(Debug, Clone)]
pub struct ApprovalDecision {
    pub allow: bool,
    pub scope: String,
}

struct PendingApproval {
    payload: Value,
    tx: mpsc::Sender<ApprovalDecision>,
}

struct PendingQuestion {
    payload: Value,
    tx: mpsc::Sender<Vec<String>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            task_id: Arc::new(Mutex::new(None)),
            approvals: Arc::new(Mutex::new(HashMap::new())),
            questions: Arc::new(Mutex::new(HashMap::new())),
            session_grants: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn task_id(&self) -> Option<String> {
        self.task_id.lock().ok().and_then(|x| x.clone())
    }

    pub fn stop(&self) -> bool {
        if !self.is_running() {
            return false;
        }
        self.cancel.store(true, Ordering::SeqCst);
        true
    }

    pub fn pending_approvals(&self) -> Vec<Value> {
        self.approvals
            .lock()
            .map(|pending| pending.values().map(|item| item.payload.clone()).collect())
            .unwrap_or_default()
    }


    pub fn pending_questions(&self) -> Vec<Value> {
        self.questions
            .lock()
            .map(|pending| pending.values().map(|item| item.payload.clone()).collect())
            .unwrap_or_default()
    }

    pub fn answer_question(
        &self,
        question_id: &str,
        answers: Vec<String>,
    ) -> Result<Value, RuntimeError> {
        let pending = self
            .questions
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "提问状态锁已损坏"))?
            .remove(question_id)
            .ok_or_else(|| RuntimeError::new("NO_QUESTION", "这个问题已经不存在或已经处理"))?;
        let expected = pending
            .payload
            .get("questions")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(1);
        let normalized = answers
            .into_iter()
            .map(|x| x.trim().to_owned())
            .collect::<Vec<_>>();
        if normalized.len() != expected || normalized.iter().any(|x| x.is_empty()) {
            return Err(RuntimeError::new("BAD_ANSWER", "每个问题都需要一个回答"));
        }
        pending
            .tx
            .send(normalized.clone())
            .map_err(|_| RuntimeError::new("QUESTION_CLOSED", "等待回答的任务已经结束"))?;
        Ok(json!({"question_id":question_id,"answers":normalized}))
    }

    pub fn respond_approval(
        &self,
        approval_id: &str,
        allow: bool,
        scope: &str,
    ) -> Result<Value, RuntimeError> {
        let pending = self
            .approvals
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "审批状态锁已损坏"))?
            .remove(approval_id)
            .ok_or_else(|| RuntimeError::new("NO_APPROVAL", "这个审批已经不存在或已经处理"))?;
        let decision = ApprovalDecision {
            allow,
            scope: if scope == "session" { "session" } else { "once" }.to_owned(),
        };
        pending
            .tx
            .send(decision.clone())
            .map_err(|_| RuntimeError::new("APPROVAL_CLOSED", "等待审批的任务已经结束"))?;
        Ok(json!({
            "approval_id": approval_id,
            "allow": decision.allow,
            "scope": decision.scope
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        app: AppHandle,
        store: ConversationStore,
        profile: Value,
        api_key: Option<String>,
        goal: String,
        conversation_id: Option<String>,
        reasoning: String,
        mode: String,
        system_context: String,
        workspace: Workspace,
        data_dir: PathBuf,
        task_id: String,
        checkpoints: CheckpointStore,
        terminal: TerminalManager,
        limits: AgentLimits,
    ) -> Result<Value, RuntimeError> {
        if !matches!(mode.as_str(), "chat" | "read" | "edit" | "agent") {
            return Err(RuntimeError::new(
                "MIGRATION_PENDING",
                format!("Native Core 不支持未知模式「{mode}」"),
            )
            .with_data(json!({"mode":mode,"available_modes":["chat","read","edit","agent"]})));
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(RuntimeError::new("AGENT_BUSY", "已有一个 AI 任务正在运行"));
        }
        self.cancel.store(false, Ordering::SeqCst);
        if let Ok(mut grants) = self.session_grants.lock() { grants.clear(); }
        if let Ok(mut slot) = self.task_id.lock() {
            *slot = Some(task_id.clone());
        }

        let result: Result<(String, Vec<Value>), RuntimeError> = (|| {
            let conversation = match conversation_id {
                Some(id) => {
                    store.get(&id)?;
                    id
                }
                None => store
                    .create(&goal)?
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RuntimeError::new("CONVERSATION_IO", "新会话缺少 id"))?
                    .to_owned(),
            };

            let mut messages = store.messages(&conversation)?;
            messages.push(json!({"role":"user","content":goal.clone()}));
            let scope = match mode.as_str() {
                "chat" => "You are Koide in CHAT mode. Converse naturally and ask the user when needed. You cannot inspect or modify project files and cannot execute commands.",
                "read" => "You are Koide in READ-ONLY mode. Inspect the project with the provided tools before making factual claims about its code. You may list, read and search files, but cannot modify files, execute commands, access paths outside the workspace, or read secrets blocked by HardPolicy.",
                "edit" => "You are Koide in EDIT mode. Inspect files before modifying them. You may list, read and search files, then request guarded file edits using the provided tools. Every write is subject to HardPolicy, permission policy and Checkpoint. Never bypass a denied action and never edit Git/Diffusion internal metadata directly.",
                "agent" => "You are Koide in full AGENT mode. Explore first, then perform the task using tools. You may read and edit workspace files, run shell commands, inspect terminal output, fetch public web pages and ask the user. Verify concrete work with tools before claiming completion. HardPolicy, permission rules and Checkpoint always outrank you.",
                _ => "You are Koide.",
            };
            messages.insert(
                0,
                json!({
                    "role":"system",
                    "content": format!("{scope}\n{system_context}")
                }),
            );

            Ok((conversation, messages))
        })();

        let (conversation, messages) = match result {
            Ok(value) => value,
            Err(error) => {
                self.running.store(false, Ordering::SeqCst);
                if let Ok(mut slot) = self.task_id.lock() {
                    *slot = None;
                }
                let _ = checkpoints.finish_task(&task_id, "error", &error.message);
                return Err(error);
            }
        };

        let running = self.running.clone();
        let cancel = self.cancel.clone();
        let task_slot = self.task_id.clone();
        let return_conversation = conversation.clone();
        let return_task = task_id.clone();
        let approvals = self.approvals.clone();
        let questions = self.questions.clone();
        let session_grants = self.session_grants.clone();

        emit(
            &app,
            "agent.started",
            json!({"task_id":task_id.clone(),"goal":goal.clone(),"mode":mode.clone()}),
        );
        emit(
            &app,
            "agent.status",
            json!({"task_id":return_task.clone(),"state":"thinking","detail":""}),
        );

        thread::spawn(move || {
            let finish = |status: &str, summary: String| {
                let _ = checkpoints.finish_task(&task_id, status, &summary);
                emit(
                    &app,
                    "agent.done",
                    json!({"task_id":task_id.clone(),"status":status,"summary":summary.clone()}),
                );
                emit(
                    &app,
                    "agent.status",
                    json!({
                        "task_id":task_id.clone(),
                        "state":if status == "error" {"error"} else if status == "stopped" {"stopped"} else {"idle"},
                        "detail":if status == "error" {summary.clone()} else {String::new()}
                    }),
                );
                running.store(false, Ordering::SeqCst);
                if let Ok(mut slot) = task_slot.lock() {
                    *slot = None;
                }
            };

            let outcome = if matches!(mode.as_str(), "read" | "edit" | "agent") {
                run_tool_mode(
                    &app,
                    &cancel,
                    &task_id,
                    &profile,
                    api_key.as_deref(),
                    messages,
                    &reasoning,
                    &workspace,
                    &data_dir,
                    &checkpoints,
                    matches!(mode.as_str(), "edit" | "agent"),
                    mode == "agent",
                    terminal.clone(),
                    limits.clone(),
                    approvals.clone(),
                    questions.clone(),
                    session_grants.clone(),
                )
            } else {
                run_chat_mode(
                    &app,
                    &cancel,
                    &task_id,
                    &profile,
                    api_key.as_deref(),
                    &messages,
                    &reasoning,
                )
            };

            match outcome {
                Ok(answer) => {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = store.append(
                            &conversation,
                            vec![
                                json!({"role":"user","text":goal.clone(),"ts":now_secs()}),
                                json!({"role":"note","text":"任务已停止","task_id":task_id.clone(),"status":"stopped","ts":now_secs()})
                            ],
                        );
                        finish("stopped", "已由你停止".into());
                        return;
                    }
                    let mut entries = vec![json!({"role":"user","text":goal,"ts":now_secs()})];
                    if !answer.trim().is_empty() {
                        entries.push(json!({"role":"assistant","text":answer.clone(),"ts":now_secs()}));
                    }
                    entries.push(json!({"role":"note","text":"任务完成","task_id":task_id.clone(),"status":"done","ts":now_secs()}));
                    let _ = store.append(&conversation, entries);
                    finish("done", answer);
                }
                Err(error) => {
                    if error.code == "STOPPED" {
                        let _ = store.append(
                            &conversation,
                            vec![
                                json!({"role":"user","text":goal,"ts":now_secs()}),
                                json!({"role":"note","text":"任务已停止","task_id":task_id.clone(),"status":"stopped","ts":now_secs()})
                            ],
                        );
                        finish("stopped", "已由你停止".into());
                        return;
                    }
                    emit(
                        &app,
                        "agent.message",
                        json!({"task_id":task_id.clone(),"delta":format!("\n\n{}", error.message)}),
                    );
                    emit(&app, "agent.turn_end", json!({"task_id":task_id.clone()}));
                    let _ = store.append(
                        &conversation,
                        vec![
                            json!({"role":"user","text":goal,"ts":now_secs()}),
                            json!({"role":"note","text":"任务失败","task_id":task_id.clone(),"status":"error","ts":now_secs()})
                        ],
                    );
                    finish("error", error.message);
                }
            }
        });

        Ok(json!({"task_id":return_task,"conversation_id":return_conversation}))
    }
}

fn run_chat_mode(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    profile: &Value,
    api_key: Option<&str>,
    messages: &[Value],
    reasoning: &str,
) -> Result<String, RuntimeError> {
    ensure_not_cancelled(cancel)?;
    let answer = chat_complete(profile, api_key, messages, reasoning)?;
    ensure_not_cancelled(cancel)?;
    emit(
        app,
        "agent.message",
        json!({"task_id":task_id,"delta":answer.clone()}),
    );
    emit(app, "agent.turn_end", json!({"task_id":task_id}));
    Ok(answer)
}

fn run_tool_mode(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    profile: &Value,
    api_key: Option<&str>,
    mut messages: Vec<Value>,
    reasoning: &str,
    workspace: &Workspace,
    data_dir: &Path,
    checkpoints: &CheckpointStore,
    editable: bool,
    full_agent: bool,
    terminal: TerminalManager,
    limits: AgentLimits,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<String, RuntimeError> {
    let shell_root = workspace.local_root_path();
    let tools = if full_agent { agent_tool_specs(shell_root.is_some()) } else if editable { edit_tool_specs() } else { read_tool_specs() };
    let mut read_revisions: HashMap<String, String> = HashMap::new();
    let mut visible = String::new();
    let mut total_calls = 0usize;
    let mut repair_attempts = 0usize;
    let started = Instant::now();

    for _round in 0..MAX_TOOL_ROUNDS {
        if limits.max_seconds > 0 && started.elapsed() >= Duration::from_secs(limits.max_seconds) {
            return Err(RuntimeError::new("LIMIT_REACHED", format!("已停止：任务运行时间达到上限（{} 秒）", limits.max_seconds)));
        }
        ensure_not_cancelled(cancel)?;
        emit(
            app,
            "agent.status",
            json!({"task_id":task_id,"state":"thinking","detail":""}),
        );
        let kind = profile.get("kind").and_then(Value::as_str).unwrap_or("openai_compatible");
        let mut emit_stream = |event| match event {
            StreamEvent::Text(delta) => emit(
                app,
                "agent.message",
                json!({"task_id":task_id,"delta":delta}),
            ),
            StreamEvent::Reasoning(delta) => emit(
                app,
                "agent.reasoning",
                json!({"task_id":task_id,"delta":delta}),
            ),
        };
        let turn = match kind {
            "anthropic" => anthropic_stream_turn(
                profile, api_key, &messages, &tools, reasoning, cancel, &mut emit_stream
            )?,
            "gemini_native" => gemini_stream_turn(
                profile, api_key, &messages, &tools, reasoning, cancel, &mut emit_stream
            )?,
            _ => openai_stream_turn(
                profile, api_key, &messages, &tools, reasoning, limits.web_search, cancel, &mut emit_stream
            )?,
        };
        ensure_not_cancelled(cancel)?;

        if !turn.text.is_empty() {
            visible.push_str(&turn.text);
        }

        if turn.tool_calls.is_empty() {
            emit(app, "agent.turn_end", json!({"task_id":task_id}));
            if visible.trim().is_empty() {
                return Err(RuntimeError::new(
                    "EMPTY_MODEL_REPLY",
                    "模型没有返回文本，也没有请求任何只读工具",
                ));
            }
            return Ok(visible);
        }

        emit(app, "agent.turn_end", json!({"task_id":task_id}));
        messages.push(turn.assistant_message);

        for call in turn.tool_calls {
            total_calls += 1;
            let configured_limit = if limits.max_tool_calls == 0 { HARD_MAX_TOOL_CALLS } else { limits.max_tool_calls };
            if total_calls > configured_limit {
                return Err(RuntimeError::new(
                    "LIMIT_REACHED",
                    if limits.max_tool_calls == 0 {
                        "智能体调用工具次数异常过多，已停止以避免无限循环".to_owned()
                    } else {
                        format!("已停止：工具调用次数达到上限（{} 次）", limits.max_tool_calls)
                    },
                ));
            }
            ensure_not_cancelled(cancel)?;
            let title = tool_title(&call);
            emit(
                app,
                "agent.tool",
                json!({
                    "task_id":task_id,
                    "call_id":call.id.clone(),
                    "title":title,
                    "args":call.arguments.clone(),
                    "state":"running",
                    "summary":""
                }),
            );

            let result = if call.name == "ask_user" {
                authorize_tool(
                    app, cancel, task_id, &call, "interaction", "low", "",
                    data_dir, profile, api_key, approvals.clone(), session_grants.clone()
                ).and_then(|_| execute_ask_user(app, cancel, task_id, &call, questions.clone()))
            } else if full_agent && call.name == "shell_run" {
                let root = shell_root.as_deref().ok_or_else(|| RuntimeError::new(
                    "WORKSPACE_CAPABILITY", "当前 Android SAF 工作区不提供 shell 工作目录能力"
                ));
                root.and_then(|root| execute_shell_tool(
                    app, cancel, task_id, &call, root, data_dir,
                    profile, api_key, approvals.clone(), session_grants.clone()
                ))
            } else if full_agent && call.name == "terminal_read" {
                execute_terminal_read(
                    app, cancel, task_id, &call, &terminal, data_dir,
                    profile, api_key, approvals.clone(), session_grants.clone()
                )
            } else if full_agent && call.name == "web_fetch" {
                execute_web_fetch(
                    app, cancel, task_id, &call, data_dir,
                    profile, api_key, approvals.clone(), session_grants.clone()
                )
            } else if matches!(call.name.as_str(), "fs_write" | "fs_patch" | "fs_create" | "fs_delete" | "fs_rename" | "fs_copy") {
                if !editable {
                    Err(RuntimeError::new("UNKNOWN_TOOL", "当前模式没有写入工具"))
                } else {
                    execute_edit_tool(
                        app,
                        cancel,
                        task_id,
                        workspace,
                        checkpoints,
                        &call,
                        &mut read_revisions,
                        profile,
                        api_key,
                        data_dir,
                        approvals.clone(),
                        session_grants.clone(),
                    )
                }
            } else {
                let target = call.arguments.get("path").and_then(Value::as_str)
                    .or_else(|| call.arguments.get("pattern").and_then(Value::as_str))
                    .or_else(|| call.arguments.get("query").and_then(Value::as_str))
                    .unwrap_or("");
                authorize_tool(
                    app, cancel, task_id, &call, "read", "low", target,
                    data_dir, profile, api_key, approvals.clone(), session_grants.clone()
                ).and_then(|_| execute_read_tool(workspace, &call))
            };
            let (payload, state, summary, detail) = match result {
                Ok(value) => {
                    if call.name == "fs_read" {
                        if let (Some(path), Some(revision)) = (
                            value.get("path").and_then(Value::as_str),
                            value.get("revision").and_then(Value::as_str),
                        ) {
                            read_revisions.insert(path.to_owned(), revision.to_owned());
                        }
                    } else if call.name == "fs_multi_read" {
                        for file in value.get("files").and_then(Value::as_array).into_iter().flatten() {
                            if let (Some(path), Some(revision)) = (
                                file.get("path").and_then(Value::as_str),
                                file.get("revision").and_then(Value::as_str),
                            ) {
                                read_revisions.insert(path.to_owned(), revision.to_owned());
                            }
                        }
                    }
                    let summary = match call.name.as_str() {
                        "fs_read" => format!("{} 行", value.get("total_lines").and_then(Value::as_u64).unwrap_or(0)),
                        "fs_list" => format!("{} 条结果", value.get("entries").and_then(Value::as_array).map(Vec::len).unwrap_or(0)),
                        "fs_search" => format!("{} 条结果", value.get("matches").and_then(Value::as_array).map(Vec::len).unwrap_or(0)),
                        "fs_glob" => format!("{} 条结果", value.get("paths").and_then(Value::as_array).map(Vec::len).unwrap_or(0)),
                        "fs_multi_read" => format!("{} 个文件", value.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0)),
                        "fs_write" | "fs_patch" | "fs_create" | "fs_delete" | "fs_rename" | "fs_copy" => "已修改".to_owned(),
                        "ask_user" => "已回答".to_owned(),
                        "shell_run" => format!("退出码 {}", value.get("exit_code").and_then(Value::as_i64).unwrap_or(-1)),
                        "terminal_read" => "已读取终端".to_owned(),
                        "web_fetch" => format!("HTTP {}", value.get("status").and_then(Value::as_u64).unwrap_or(0)),
                        _ => "完成".to_owned(),
                    };
                    if matches!(call.name.as_str(), "fs_read" | "fs_list" | "fs_search" | "fs_glob" | "fs_multi_read") {
                        let _ = checkpoints.add_event(
                            task_id,
                            "read",
                            &tool_title(&call),
                            json!({"tool":call.name.clone(),"arguments":call.arguments.clone(),"summary":summary.clone()}),
                        );
                    } else if call.name == "shell_run" {
                        let exit_code = value.get("exit_code").and_then(Value::as_i64).unwrap_or(-1);
                        let timed_out = value.get("timed_out").and_then(Value::as_bool).unwrap_or(false);
                        let ok = exit_code == 0 && !timed_out;
                        let command = call.arguments.get("command").and_then(Value::as_str).unwrap_or("");
                        let title = format!("{}：{}", if ok { "通过" } else { "失败" }, command.chars().take(80).collect::<String>());
                        let detail = value.get("output").and_then(Value::as_str).unwrap_or("");
                        let detail = detail.chars().rev().take(1500).collect::<String>().chars().rev().collect::<String>();
                        let _ = checkpoints.add_event(
                            task_id,
                            if ok { "build_ok" } else { "build_failed" },
                            &title,
                            json!({"tool":"shell_run","arguments":call.arguments.clone(),"detail":detail,"exit_code":exit_code}),
                        );
                    }
                    (value, "done", summary, String::new())
                },
                Err(error) if matches!(error.code.as_str(), "SENSITIVE_PATH" | "OUTSIDE_WORKSPACE" | "USER_DECLINED") => {
                    let code = error.code.clone();
                    let message = error.message.clone();
                    (
                        json!({"error":{"code":code,"message":message.clone()}}),
                        "denied",
                        "已拒绝".into(),
                        message,
                    )
                }
                Err(error) => {
                    if matches!(error.code.as_str(), "BAD_TOOL_ARGS" | "UNKNOWN_TOOL") {
                        repair_attempts += 1;
                        if repair_attempts > limits.max_repair_attempts {
                            return Err(RuntimeError::new(
                                "REPAIR_LIMIT",
                                format!("工具参数连续失败，已达到修复上限（{} 次）", limits.max_repair_attempts),
                            ));
                        }
                    }
                    let code = error.code.clone();
                    let message = error.message.clone();
                    (
                        json!({"error":{"code":code,"message":message.clone()}}),
                        "error",
                        "失败".into(),
                        message,
                    )
                },
            };

            emit(
                app,
                "agent.tool",
                json!({
                    "task_id":task_id,
                    "call_id":call.id.clone(),
                    "title":tool_title(&call),
                    "args":call.arguments.clone(),
                    "state":state,
                    "summary":summary,
                    "detail":detail
                }),
            );
            messages.push(json!({
                "role":"tool",
                "tool_call_id":call.id,
                "name":call.name,
                "content":serde_json::to_string(&payload).unwrap_or_else(|_| "{\"error\":\"serialize\"}".into())
            }));
        }
    }

    Err(RuntimeError::new(
        "TOOL_LIMIT",
        "只读智能体达到最大工具轮次，已停止以避免无限循环",
    ))
}

fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<(), RuntimeError> {
    if cancel.load(Ordering::SeqCst) {
        Err(RuntimeError::new("STOPPED", "已由你停止"))
    } else {
        Ok(())
    }
}

fn read_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "type":"function",
            "function":{
                "name":"fs_list",
                "description":"List files and folders inside the current workspace. Use this to understand project structure before reading files.",
                "parameters":{
                    "type":"object",
                    "properties":{
                        "path":{"type":"string","description":"Workspace-relative directory, or . for the root."},
                        "depth":{"type":"integer","minimum":1,"maximum":4}
                    },
                    "additionalProperties":false
                }
            }
        }),
        json!({
            "type":"function",
            "function":{
                "name":"fs_read",
                "description":"Read a UTF-8 text file inside the workspace. Sensitive credential paths are blocked by HardPolicy.",
                "parameters":{
                    "type":"object",
                    "properties":{
                        "path":{"type":"string"},
                        "start_line":{"type":"integer","minimum":1},
                        "end_line":{"type":"integer","minimum":1}
                    },
                    "required":["path"],
                    "additionalProperties":false
                }
            }
        }),
        json!({
            "type":"function",
            "function":{
                "name":"fs_glob",
                "description":"Find files or folders by workspace-relative wildcard pattern such as **/*.rs or src/*.js, without reading file contents.",
                "parameters":{
                    "type":"object",
                    "properties":{
                        "pattern":{"type":"string","minLength":1},
                        "max_results":{"type":"integer","minimum":1,"maximum":500}
                    },
                    "required":["pattern"],
                    "additionalProperties":false
                }
            }
        }),
        json!({
            "type":"function",
            "function":{
                "name":"fs_multi_read",
                "description":"Read several known UTF-8 text files in one call. Up to 20 paths. Sensitive paths are blocked by HardPolicy.",
                "parameters":{
                    "type":"object",
                    "properties":{
                        "paths":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"string"}}
                    },
                    "required":["paths"],
                    "additionalProperties":false
                }
            }
        }),
        json!({
            "type":"function",
            "function":{
                "name":"fs_search",
                "description":"Search literal text across readable text files in the workspace. Returns matching paths, line numbers, and short line previews.",
                "parameters":{
                    "type":"object",
                    "properties":{
                        "query":{"type":"string","minLength":1},
                        "case_sensitive":{"type":"boolean"},
                        "max_results":{"type":"integer","minimum":1,"maximum":200}
                    },
                    "required":["query"],
                    "additionalProperties":false
                }
            }
        }),
        json!({
            "type":"function","function":{
                "name":"ask_user","description":"Ask the user one or more concise questions when an important choice or missing fact cannot be inferred safely.",
                "parameters":{"type":"object","properties":{
                    "questions":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","properties":{"question":{"type":"string","minLength":1},"options":{"type":"array","items":{"type":"string"}},"allow_custom":{"type":"boolean"}},"required":["question"],"additionalProperties":false}},
                    "question":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"allow_custom":{"type":"boolean"}
                },"additionalProperties":false}
            }
        }),
    ]
}

fn tool_title(call: &ToolCall) -> String {
    match call.name.as_str() {
        "fs_read" => format!(
            "读取“{}”",
            call.arguments.get("path").and_then(Value::as_str).unwrap_or("")
        ),
        "fs_list" => format!(
            "浏览“{}”",
            call.arguments.get("path").and_then(Value::as_str).unwrap_or(".")
        ),
        "fs_search" => format!(
            "搜索“{}”",
            call.arguments.get("query").and_then(Value::as_str).unwrap_or("")
        ),
        "fs_glob" => format!(
            "查找“{}”",
            call.arguments.get("pattern").and_then(Value::as_str).unwrap_or("")
        ),
        "fs_multi_read" => "批量读取文件".to_owned(),
        "ask_user" => "向你提问".to_owned(),
        "shell_run" => format!(
            "运行“{}”",
            call.arguments.get("command").and_then(Value::as_str).unwrap_or("").chars().take(80).collect::<String>()
        ),
        "terminal_read" => "读取终端输出".to_owned(),
        "web_fetch" => format!(
            "访问“{}”",
            call.arguments.get("url").and_then(Value::as_str).unwrap_or("").chars().take(90).collect::<String>()
        ),
        _ => call.name.clone(),
    }
}

fn execute_read_tool(workspace: &Workspace, call: &ToolCall) -> Result<Value, RuntimeError> {
    match call.name.as_str() {
        "fs_list" => {
            let raw = call.arguments.get("path").and_then(Value::as_str).unwrap_or(".");
            check_read_path(raw)?;
            let depth = call.arguments.get("depth").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4) as usize;
            let nodes = workspace.tree(raw, depth, true)?;
            let mut entries = Vec::new();
            fn flatten(nodes: &[Value], out: &mut Vec<Value>) {
                for node in nodes {
                    let mut item = node.clone();
                    if let Some(obj) = item.as_object_mut() { obj.remove("children"); }
                    if item.get("path").and_then(Value::as_str).is_some_and(|p| check_read_path(p).is_ok()) {
                        out.push(item);
                    }
                    if let Some(children) = node.get("children").and_then(Value::as_array) { flatten(children, out); }
                }
            }
            flatten(nodes.as_array().map(Vec::as_slice).unwrap_or(&[]), &mut entries);
            Ok(json!({"entries":entries}))
        }
        "fs_read" => {
            let raw = required_arg(&call.arguments, "path")?;
            check_read_path(raw)?;
            let value = workspace.read(raw)?;
            if value.get("binary").and_then(Value::as_bool) == Some(true) {
                return Ok(value);
            }
            let text = value.get("content").and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::new("BINARY_FILE", format!("{raw} 不是 UTF-8 文本文件")))?;
            let lines = text.split('\n').collect::<Vec<_>>();
            let start = call.arguments.get("start_line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
            let end = call.arguments.get("end_line").and_then(Value::as_u64).unwrap_or(lines.len() as u64).max(1) as usize;
            let start = start.min(lines.len().max(1));
            let end = end.min(lines.len()).max(start);
            let content = if call.arguments.get("start_line").is_some() || call.arguments.get("end_line").is_some() {
                (start..=end).map(|n| format!("{n}: {}", lines.get(n - 1).copied().unwrap_or(""))).collect::<Vec<_>>().join("\n")
            } else { text.to_owned() };
            Ok(json!({
                "path":value.get("path").cloned().unwrap_or_else(||Value::String(raw.to_owned())),
                "revision":value.get("revision").cloned().unwrap_or_else(||Value::String("absent".into())),
                "total_lines":lines.len(),"range":[start,end],"content":content
            }))
        }
        "fs_glob" => {
            let pattern = required_arg(&call.arguments, "pattern")?;
            let max_results = call.arguments.get("max_results").and_then(Value::as_u64).unwrap_or(200).clamp(1, 500) as usize;
            let value = workspace.glob(pattern, max_results.saturating_mul(4).max(max_results))?;
            let mut paths = value.get("paths").and_then(Value::as_array).into_iter().flatten()
                .filter_map(Value::as_str).filter(|p| check_read_path(p).is_ok()).take(max_results).map(str::to_owned).collect::<Vec<_>>();
            paths.truncate(max_results);
            Ok(json!({"truncated":paths.len()>=max_results,"paths":paths}))
        }
        "fs_multi_read" => {
            let paths = call.arguments.get("paths").and_then(Value::as_array)
                .ok_or_else(|| RuntimeError::new("BAD_TOOL_ARGS", "fs_multi_read 缺少 paths"))?;
            let mut files = Vec::new();
            for raw in paths.iter().take(20).filter_map(Value::as_str) {
                let nested = ToolCall { id:String::new(), name:"fs_read".into(), arguments:json!({"path":raw}) };
                match execute_read_tool(workspace, &nested) {
                    Ok(value) => files.push(value),
                    Err(error) => files.push(json!({"path":raw,"error":format!("{}: {}",error.code,error.message)})),
                }
            }
            Ok(json!({"files":files}))
        }
        "fs_search" => {
            let query = required_arg(&call.arguments, "query")?;
            if query.is_empty() { return Err(RuntimeError::new("BAD_QUERY", "搜索内容不能为空")); }
            let case_sensitive = call.arguments.get("case_sensitive").and_then(Value::as_bool).unwrap_or(false);
            let max_results = call.arguments.get("max_results").and_then(Value::as_u64).unwrap_or(100).clamp(1, 200) as usize;
            // HardPolicy must prevent even internal reads of credential paths. Enumerate first,
            // filter paths, then read only allowed files instead of calling the unrestricted UI search.
            let all = workspace.glob("*", 5000)?;
            let needle = if case_sensitive { query.to_owned() } else { query.to_lowercase() };
            let mut matches = Vec::new();
            let mut scanned = 0usize;
            for path in all.get("paths").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                if matches.len() >= max_results { break; }
                if check_read_path(path).is_err() { continue; }
                let Ok(value) = workspace.read(path) else { continue; };
                if value.get("binary").and_then(Value::as_bool) == Some(true) { continue; }
                let Some(text) = value.get("content").and_then(Value::as_str) else { continue; };
                scanned += 1;
                for (idx,line) in text.lines().enumerate() {
                    let hay = if case_sensitive { line.to_owned() } else { line.to_lowercase() };
                    if let Some(column)=hay.find(&needle) {
                        matches.push(json!({"path":path,"line":idx+1,"column":column+1,"text":line.chars().take(300).collect::<String>()}));
                        if matches.len() >= max_results { break; }
                    }
                }
            }
            Ok(json!({"matches":matches,"files_scanned":scanned,"truncated":matches.len()>=max_results}))
        }
        _ => Err(RuntimeError::new("UNKNOWN_TOOL", format!("未知的只读工具：{}", call.name))),
    }
}

fn required_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, RuntimeError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::new("BAD_TOOL_ARGS", format!("工具参数缺少 {key}")))
}

fn resolve_inside(root: &Path, raw: &str) -> Result<PathBuf, RuntimeError> {
    let rel = Path::new(raw);
    if rel.is_absolute() {
        return Err(RuntimeError::new("OUTSIDE_WORKSPACE", "只允许工作区相对路径"));
    }
    for part in rel.components() {
        if matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_)) {
            return Err(RuntimeError::new("OUTSIDE_WORKSPACE", "路径试图离开工作区"));
        }
    }
    let candidate = root.join(rel);
    let real = fs::canonicalize(&candidate)
        .map_err(|e| RuntimeError::new("NOT_FOUND", format!("{raw}: {e}")))?;
    if !real.starts_with(root) {
        return Err(RuntimeError::new("OUTSIDE_WORKSPACE", "符号链接指向了工作区之外"));
    }
    Ok(real)
}

fn display_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|p| {
            if p.as_os_str().is_empty() {
                ".".into()
            } else {
                p.to_string_lossy().replace('\\', "/")
            }
        })
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn list_dir(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Value>) -> Result<(), RuntimeError> {
    let mut entries = fs::read_dir(dir)
        .map_err(|e| RuntimeError::new("READ_FAILED", format!("{}: {e}", dir.display())))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

    for entry in entries {
        let ty = match entry.file_type() {
            Ok(ty) => ty,
            Err(_) => continue,
        };
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        let rel = display_rel(root, &path);
        if check_read_path(&rel).is_err() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), "node_modules" | "target" | ".git" | ".gradle" | ".idea" | "__pycache__" | ".venv" | "venv") {
            continue;
        }
        out.push(json!({
            "path":rel,
            "type":if ty.is_dir() {"dir"} else {"file"}
        }));
        if ty.is_dir() && depth > 1 {
            list_dir(root, &path, depth - 1, out)?;
        }
    }
    Ok(())
}

fn glob_dir(
    root: &Path,
    dir: &Path,
    pattern: &str,
    max_results: usize,
    out: &mut Vec<String>,
) -> Result<(), RuntimeError> {
    if out.len() >= max_results {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.filter_map(Result::ok) {
        if out.len() >= max_results {
            break;
        }
        let Ok(ty) = entry.file_type() else { continue };
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        let rel = display_rel(root, &path);
        if check_read_path(&rel).is_err() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ty.is_dir() && matches!(
            name.as_str(),
            "node_modules" | "target" | ".git" | ".gradle" | ".idea" | "__pycache__" | ".venv" | "venv"
        ) {
            continue;
        }
        if wildcard_match(pattern, &rel) {
            out.push(rel.clone());
        }
        if ty.is_dir() {
            glob_dir(root, &path, pattern, max_results, out)?;
        }
    }
    Ok(())
}

fn search_dir(
    root: &Path,
    dir: &Path,
    query: &str,
    case_sensitive: bool,
    max_results: usize,
    matches: &mut Vec<Value>,
    scanned: &mut usize,
) -> Result<(), RuntimeError> {
    if matches.len() >= max_results {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.filter_map(Result::ok) {
        if matches.len() >= max_results {
            break;
        }
        let Ok(ty) = entry.file_type() else { continue };
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        let rel = display_rel(root, &path);
        if check_read_path(&rel).is_err() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ty.is_dir() {
            if matches!(name.as_str(), "node_modules" | "target" | ".git" | ".gradle" | ".idea" | "__pycache__" | ".venv" | "venv") {
                continue;
            }
            search_dir(root, &path, query, case_sensitive, max_results, matches, scanned)?;
            continue;
        }
        if !ty.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > 1_000_000 {
            continue;
        }
        let Ok(data) = fs::read(&path) else { continue };
        if data[..data.len().min(4096)].contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&data) else { continue };
        *scanned += 1;
        let needle = if case_sensitive { query.to_owned() } else { query.to_lowercase() };
        for (idx, line) in text.lines().enumerate() {
            let hay = if case_sensitive { line.to_owned() } else { line.to_lowercase() };
            if let Some(column) = hay.find(&needle) {
                matches.push(json!({
                    "path":rel,
                    "line":idx + 1,
                    "column":column + 1,
                    "text":line.chars().take(300).collect::<String>()
                }));
                if matches.len() >= max_results {
                    break;
                }
            }
        }
    }
    Ok(())
}



fn execute_ask_user(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    questions_state: Arc<Mutex<HashMap<String, PendingQuestion>>>,
) -> Result<Value, RuntimeError> {
    let mut questions = call
        .arguments
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if questions.is_empty() {
        if let Some(question) = call.arguments.get("question").and_then(Value::as_str) {
            questions.push(json!({
                "question":question,
                "options":call.arguments.get("options").cloned().unwrap_or_else(|| json!([])),
                "allow_custom":call.arguments.get("allow_custom").and_then(Value::as_bool).unwrap_or(true)
            }));
        }
    }
    if questions.is_empty() || questions.len() > 6 {
        return Err(RuntimeError::new("BAD_ARGUMENTS", "ask_user 需要 1 到 6 个问题"));
    }
    for q in &mut questions {
        let question = q.get("question").and_then(Value::as_str).unwrap_or("").trim();
        if question.is_empty() {
            return Err(RuntimeError::new("BAD_ARGUMENTS", "问题文本不能为空"));
        }
        if let Some(obj)=q.as_object_mut() {
            obj.entry("options").or_insert_with(|| json!([]));
            obj.entry("allow_custom").or_insert(Value::Bool(true));
        }
    }

    let question_id = unique_id("question-");
    let (tx, rx) = mpsc::channel();
    let payload = json!({
        "question_id":question_id,
        "task_id":task_id,
        "call_id":call.id,
        "questions":questions
    });
    questions_state.lock()
        .map_err(|_| RuntimeError::new("LOCK_POISONED","提问状态锁已损坏"))?
        .insert(question_id.clone(), PendingQuestion { payload:payload.clone(), tx });
    let _ = app.emit("diffusion://event", RuntimeEvent { event:"agent.question".into(), data:payload });
    let _ = app.emit("diffusion://event", RuntimeEvent {
        event:"agent.status".into(),
        data:json!({"task_id":task_id,"state":"waiting_user","detail":"等待你的回答"})
    });

    loop {
        if cancel.load(Ordering::SeqCst) {
            if let Ok(mut q)=questions_state.lock() { q.remove(&question_id); }
            return Err(RuntimeError::new("STOPPED","已由你停止"));
        }
        match rx.recv_timeout(Duration::from_millis(120)) {
            Ok(answers) => {
                let summary = questions.iter().zip(answers.iter()).map(|(q,a)| json!({
                    "question":q.get("question").and_then(Value::as_str).unwrap_or(""),
                    "answer":a
                })).collect::<Vec<_>>();
                return Ok(json!({"answers":answers,"summary":summary}));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(RuntimeError::new("QUESTION_CLOSED","提问通道已经关闭"));
            }
        }
    }
}

fn edit_tool_specs() -> Vec<Value> {
    let mut tools = read_tool_specs();
    tools.extend([
        json!({"type":"function","function":{
            "name":"fs_write","description":"Write complete UTF-8 text to a workspace file. Existing files MUST be read first. Requires user approval.",
            "parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}
        }}),
        json!({"type":"function","function":{
            "name":"fs_patch","description":"Patch a text file after reading it. Edits may use old_text/new_text or range/new_text. Requires user approval.",
            "parameters":{"type":"object","properties":{"path":{"type":"string"},"edits":{"type":"array","minItems":1,"items":{"type":"object"}}},"required":["path","edits"],"additionalProperties":false}
        }}),
        json!({"type":"function","function":{
            "name":"fs_create","description":"Create a new UTF-8 text file or folder. Requires user approval.",
            "parameters":{"type":"object","properties":{"path":{"type":"string"},"kind":{"type":"string","enum":["file","dir"]},"content":{"type":"string"}},"required":["path"],"additionalProperties":false}
        }}),
        json!({"type":"function","function":{
            "name":"fs_delete","description":"Delete a FILE by moving it to Koide 回收站. Directory deletion is intentionally not exposed to the agent. Requires user approval.",
            "parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}
        }}),
        json!({"type":"function","function":{
            "name":"fs_rename","description":"Rename or move a FILE inside the workspace. Requires user approval.",
            "parameters":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"}},"required":["from","to"],"additionalProperties":false}
        }}),
        json!({"type":"function","function":{
            "name":"fs_copy","description":"Copy a FILE inside the workspace. Requires user approval.",
            "parameters":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"}},"required":["from","to"],"additionalProperties":false}
        }})
    ]);
    tools
}

fn agent_tool_specs(shell_available: bool) -> Vec<Value> {
    let mut tools = edit_tool_specs();
    if shell_available {
        tools.extend([
            json!({"type":"function","function":{
                "name":"shell_run",
                "description":"Run a shell command in the workspace root to build, test or inspect the project. Dangerous commands may be denied or require explicit user approval.",
                "parameters":{"type":"object","properties":{
                    "command":{"type":"string","minLength":1},
                    "timeout_seconds":{"type":"number","minimum":1,"maximum":1800}
                },"required":["command"],"additionalProperties":false}
            }}),
            json!({"type":"function","function":{
                "name":"terminal_read",
                "description":"Read recent output from the user's interactive terminal without recording keystrokes.",
                "parameters":{"type":"object","properties":{
                    "id":{"type":"string"},
                    "max_chars":{"type":"integer","minimum":100,"maximum":20000}
                },"additionalProperties":false}
            }})
        ]);
    }
    tools.push(json!({"type":"function","function":{
        "name":"web_fetch",
        "description":"Fetch readable content from a public http/https URL. Localhost and private-network targets are blocked by HardPolicy.",
        "parameters":{"type":"object","properties":{
            "url":{"type":"string","minLength":1}
        },"required":["url"],"additionalProperties":false}
    }}));
    tools
}

#[allow(clippy::too_many_arguments)]
fn execute_shell_tool(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    workspace_root: &Path,
    data_dir: &Path,
    profile: &Value,
    api_key: Option<&str>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<Value, RuntimeError> {
    let command = required_arg(&call.arguments, "command")?;
    if let Some(verdict) = check_command(command) {
        match verdict.action {
            CommandPolicyAction::Deny => {
                return Err(RuntimeError::new("POLICY_DENIED", verdict.reason));
            }
            CommandPolicyAction::Ask => {
                request_user_approval(
                    app, cancel, task_id, call, "exec", "high", verdict.reason,
                    "hard_policy", approvals.clone(), session_grants.clone()
                )?;
            }
        }
    } else {
        authorize_tool(
            app, cancel, task_id, call, "exec", "medium", command,
            data_dir, profile, api_key, approvals.clone(), session_grants.clone()
        )?;
    }
    ensure_not_cancelled(cancel)?;
    let timeout = call.arguments.get("timeout_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(120.0)
        .clamp(1.0, 1800.0);
    emit(app, "terminal.start", json!({
        "source":"agent","call_id":call.id,"command":command
    }));
    let result = run_capture(
        workspace_root,
        command,
        Duration::from_secs_f64(timeout),
        cancel,
    )?;
    let output = result.get("output").and_then(Value::as_str).unwrap_or("");
    if !output.is_empty() {
        emit(app, "terminal.output", json!({
            "source":"agent","call_id":call.id,"stream":"stdout","data":output
        }));
    }
    emit(app, "terminal.exit", json!({
        "source":"agent",
        "call_id":call.id,
        "exit_code":result.get("exit_code").and_then(Value::as_i64).unwrap_or(-1)
    }));
    if result.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Err(RuntimeError::new("STOPPED", "已由你停止"));
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn execute_terminal_read(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    terminal: &TerminalManager,
    data_dir: &Path,
    profile: &Value,
    api_key: Option<&str>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<Value, RuntimeError> {
    authorize_tool(
        app, cancel, task_id, call, "exec", "low", "",
        data_dir, profile, api_key, approvals, session_grants
    )?;
    ensure_not_cancelled(cancel)?;
    let max_chars = call.arguments.get("max_chars")
        .and_then(Value::as_u64)
        .unwrap_or(4000)
        .clamp(100, 20000) as usize;
    let value = if let Some(id) = call.arguments.get("id").and_then(Value::as_str) {
        let hist = terminal.history(id)?;
        let data = hist.get("data").and_then(Value::as_str).unwrap_or("");
        json!({
            "id":id,
            "alive":hist.get("alive").and_then(Value::as_bool).unwrap_or(false),
            "output":tail_chars(data,max_chars)
        })
    } else if let Some((id,data)) = terminal.last_history() {
        json!({"id":id,"alive":true,"output":tail_chars(&data,max_chars)})
    } else {
        json!({"output":"","note":"没有打开的终端会话"})
    };
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn execute_web_fetch(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    data_dir: &Path,
    profile: &Value,
    api_key: Option<&str>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<Value, RuntimeError> {
    let url = required_arg(&call.arguments, "url")?.trim();
    ensure_public_http_url(url)?;
    authorize_tool(
        app, cancel, task_id, call, "network", "medium", url,
        data_dir, profile, api_key, approvals, session_grants
    )?;
    ensure_not_cancelled(cancel)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| RuntimeError::new("WEB_FETCH_FAILED", e.to_string()))?;
    let mut current = reqwest::Url::parse(url)
        .map_err(|_| RuntimeError::new("BAD_URL", "网址格式无效"))?;
    let mut response = None;
    for _ in 0..=5 {
        ensure_not_cancelled(cancel)?;
        ensure_public_http_url(current.as_str())?;
        let resp = client.get(current.clone())
            .header("User-Agent","Diffusion-IDE-Agent/1.0")
            .header("Accept","text/html,text/plain,application/json;q=0.9,*/*;q=0.5")
            .send()
            .map_err(|e| RuntimeError::new("WEB_FETCH_FAILED", e.to_string()))?;
        if resp.status().is_redirection() {
            let location = resp.headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| RuntimeError::new("WEB_FETCH_FAILED", "重定向响应缺少 Location"))?;
            current = current.join(location)
                .map_err(|_| RuntimeError::new("BAD_URL", "重定向地址无效"))?;
            continue;
        }
        response = Some(resp);
        break;
    }
    let mut response = response
        .ok_or_else(|| RuntimeError::new("WEB_FETCH_FAILED", "重定向次数过多"))?;
    ensure_not_cancelled(cancel)?;
    let final_url = response.url().as_str().to_owned();
    ensure_public_http_url(&final_url)?;
    let status = response.status().as_u16();
    let ctype = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v|v.to_str().ok()).unwrap_or("").to_owned();
    let mut data = Vec::new();
    response.by_ref().take((WEB_FETCH_MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|e| RuntimeError::new("WEB_FETCH_FAILED", e.to_string()))?;
    let truncated_bytes = data.len() > WEB_FETCH_MAX_BYTES;
    if truncated_bytes { data.truncate(WEB_FETCH_MAX_BYTES); }
    let raw = String::from_utf8_lossy(&data).into_owned();
    let readable = if ctype.to_ascii_lowercase().contains("html") {
        strip_html(&raw)
    } else {
        raw
    };
    let truncated_chars = readable.chars().count() > WEB_FETCH_MAX_CHARS;
    let content = readable.chars().take(WEB_FETCH_MAX_CHARS).collect::<String>();
    Ok(json!({
        "url":final_url,
        "status":status,
        "content_type":ctype,
        "content":content,
        "truncated":truncated_bytes || truncated_chars
    }))
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max_chars)).collect()
}

fn strip_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(WEB_FETCH_MAX_CHARS * 2));
    let mut in_tag = false;
    let mut last_space = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                if !last_space { out.push(' '); last_space = true; }
            }
            _ if in_tag => {}
            '&' => {
                if !last_space { out.push(' '); last_space = true; }
            }
            c if c.is_whitespace() => {
                if !last_space { out.push(' '); last_space = true; }
            }
            c => { out.push(c); last_space = false; }
        }
        if out.len() > WEB_FETCH_MAX_CHARS * 4 { break; }
    }
    out.trim().to_owned()
}

#[allow(clippy::too_many_arguments)]
fn execute_edit_tool(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    workspace: &Workspace,
    checkpoints: &CheckpointStore,
    call: &ToolCall,
    read_revisions: &mut HashMap<String, String>,
    profile: &Value,
    api_key: Option<&str>,
    data_dir: &Path,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<Value, RuntimeError> {
    ensure_not_cancelled(cancel)?;

    let primary = call.arguments.get("path").and_then(Value::as_str)
        .or_else(|| call.arguments.get("from").and_then(Value::as_str))
        .ok_or_else(|| RuntimeError::new("BAD_TOOL_ARGS", "写入工具缺少 path/from"))?;
    check_write_path(primary)?;
    if let Some(to) = call.arguments.get("to").and_then(Value::as_str) {
        check_write_path(to)?;
    }

    authorize_tool(
        app,
        cancel,
        task_id,
        call,
        "write",
        if call.name == "fs_delete" { "medium" } else { "medium" },
        primary,
        data_dir,
        profile,
        api_key,
        approvals,
        session_grants,
    )?;
    ensure_not_cancelled(cancel)?;

    match call.name.as_str() {
        "fs_write" => {
            let path = required_arg(&call.arguments, "path")?;
            let content = required_arg(&call.arguments, "content")?;
            let before = workspace.read(path).ok();
            let base = if before.is_some() {
                let rev = read_revisions.get(path).ok_or_else(|| RuntimeError::new(
                    "NEEDS_READ",
                    format!("修改 {path} 之前请先用 fs_read 读取它"),
                ))?;
                Some(rev.as_str())
            } else {
                Some("absent")
            };
            let before_bytes = before.as_ref()
                .and_then(|v| v.get("content").and_then(Value::as_str))
                .map(str::as_bytes);
            checkpoints.record_before(task_id, path, before_bytes)?;
            let mutation = workspace.write_text(path, content, base)?;
            record_agent_mutation(app, checkpoints, task_id, &mutation.event, before_bytes)?;
            if let Some(rev) = mutation.result.get("revision").and_then(Value::as_str) {
                read_revisions.insert(path.to_owned(), rev.to_owned());
            }
            Ok(mutation.result)
        }
        "fs_patch" => {
            let path = required_arg(&call.arguments, "path")?;
            let edits = call.arguments.get("edits").and_then(Value::as_array)
                .ok_or_else(|| RuntimeError::new("BAD_TOOL_ARGS", "fs_patch 缺少 edits"))?;
            let base = read_revisions.get(path).cloned().ok_or_else(|| RuntimeError::new(
                "NEEDS_READ",
                format!("修改 {path} 之前请先用 fs_read 读取它"),
            ))?;
            let before_value = workspace.read(path)?;
            let before_text = before_value.get("content").and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::new("BINARY_FILE", format!("{path} 不是 UTF-8 文本")))?;
            checkpoints.record_before(task_id, path, Some(before_text.as_bytes()))?;
            let mutation = workspace.patch(path, &base, edits)?;
            record_agent_mutation(app, checkpoints, task_id, &mutation.event, Some(before_text.as_bytes()))?;
            if let Some(rev) = mutation.result.get("revision").and_then(Value::as_str) {
                read_revisions.insert(path.to_owned(), rev.to_owned());
            }
            Ok(mutation.result)
        }
        "fs_create" => {
            let path = required_arg(&call.arguments, "path")?;
            let kind = call.arguments.get("kind").and_then(Value::as_str).unwrap_or("file");
            let content = call.arguments.get("content").and_then(Value::as_str).unwrap_or("");
            checkpoints.record_before(task_id, path, None)?;
            let mutation = workspace.create(path, kind, content)?;
            record_agent_mutation(app, checkpoints, task_id, &mutation.event, None)?;
            if let Some(rev) = mutation.result.get("revision").and_then(Value::as_str) {
                read_revisions.insert(path.to_owned(), rev.to_owned());
            }
            Ok(mutation.result)
        }
        "fs_delete" => {
            let path = required_arg(&call.arguments, "path")?;
            let before = workspace.read(path).map_err(|e| {
                if e.code == "NOT_FOUND" { e } else {
                    RuntimeError::new("POLICY_DENIED", "智能体当前只允许删除普通文件，不允许删除文件夹")
                }
            })?;
            let text = before.get("content").and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::new("POLICY_DENIED", "智能体当前只允许删除 UTF-8 文本文件"))?;
            checkpoints.record_before(task_id, path, Some(text.as_bytes()))?;
            let mutation = workspace.delete(path)?;
            record_agent_mutation(app, checkpoints, task_id, &mutation.event, Some(text.as_bytes()))?;
            read_revisions.remove(path);
            Ok(mutation.result)
        }
        "fs_rename" => {
            let from = required_arg(&call.arguments, "from")?;
            let to = required_arg(&call.arguments, "to")?;
            let before = workspace.read(from)?;
            let text = before.get("content").and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::new("POLICY_DENIED", "智能体当前只允许重命名 UTF-8 文本文件"))?;
            checkpoints.record_before(task_id, from, Some(text.as_bytes()))?;
            checkpoints.record_before(task_id, to, None)?;
            let mutation = workspace.rename(from, to)?;
            let before_blob = checkpoints.blob_for_event_before(Some(text.as_bytes()))?;
            checkpoints.add_event(task_id, "edit", &format!("删除 {from}"), json!({
                "path":from,"kind":"delete","before_blob":before_blob,"existed_before":true,
                "after_rev":"absent","old_path":from,"new_path":to
            }))?;
            let after_rev = workspace.read(to)?.get("revision").cloned().unwrap_or(Value::String("absent".into()));
            checkpoints.add_event(task_id, "edit", &format!("新建 {to}"), json!({
                "path":to,"kind":"create","before_blob":Value::Null,"existed_before":false,
                "after_rev":after_rev,"old_path":from,"new_path":to
            }))?;
            let mut event = mutation.event.clone();
            if let Some(obj) = event.as_object_mut() {
                obj.insert("actor".into(), Value::String("agent".into()));
                obj.insert("task_id".into(), Value::String(task_id.into()));
            }
            let _ = app.emit("diffusion://event", RuntimeEvent { event:"fs.changed".into(), data:event });
            read_revisions.remove(from);
            if let Ok(v) = workspace.read(to) {
                if let Some(rev)=v.get("revision").and_then(Value::as_str) { read_revisions.insert(to.to_owned(), rev.to_owned()); }
            }
            Ok(mutation.result)
        }
        "fs_copy" => {
            let from = required_arg(&call.arguments, "from")?;
            let to = required_arg(&call.arguments, "to")?;
            let before = workspace.read(from)?;
            before.get("content").and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::new("POLICY_DENIED", "智能体当前只允许复制 UTF-8 文本文件"))?;
            checkpoints.record_before(task_id, to, None)?;
            let result = workspace.copy(from, to)?;
            let after = workspace.read(to)?;
            checkpoints.add_event(task_id, "edit", &format!("新建 {to}"), json!({
                "path":to,"kind":"create","before_blob":Value::Null,"existed_before":false,
                "after_rev":after.get("revision").cloned().unwrap_or(Value::String("absent".into()))
            }))?;
            let _ = app.emit("diffusion://event", RuntimeEvent {
                event:"fs.changed".into(),
                data:json!({"kind":"create","path":to,"actor":"agent","task_id":task_id})
            });
            if let Some(rev)=after.get("revision").and_then(Value::as_str) { read_revisions.insert(to.to_owned(), rev.to_owned()); }
            Ok(result)
        }
        _ => Err(RuntimeError::new("UNKNOWN_TOOL", format!("未知编辑工具：{}", call.name))),
    }
}

fn authorize_tool(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    permission_class: &str,
    risk: &str,
    target: &str,
    data_dir: &Path,
    main_profile: &Value,
    main_key: Option<&str>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<(), RuntimeError> {
    let settings = SettingsStore::new(data_dir);
    let granted = session_grants
        .lock()
        .map(|g| g.contains(&call.name))
        .unwrap_or(false);
    let decision = settings.evaluate_tool(&call.name, permission_class, risk, target, granted);

    match decision.action {
        PermissionAction::Allow => return Ok(()),
        PermissionAction::Deny => {
            return Err(RuntimeError::new("POLICY_DENIED", decision.reason));
        }
        PermissionAction::AiReview => {
            match review_tool_with_ai(
                &settings,
                main_profile,
                main_key,
                call,
                permission_class,
                risk,
                target,
                data_dir,
            ) {
                Ok(("ALLOW", _)) => return Ok(()),
                Ok(("DENY", reason)) => {
                    return Err(RuntimeError::new(
                        "POLICY_DENIED",
                        if reason.is_empty() { "审批模型已拒绝".into() } else { reason },
                    ));
                }
                Ok(("ASK_USER", reason)) => {
                    return request_user_approval(
                        app, cancel, task_id, call, permission_class, risk,
                        if reason.is_empty() { "审批模型建议由你确认".into() } else { reason },
                        "approval_agent",
                        approvals, session_grants,
                    );
                }
                Ok(_) | Err(_) => {
                    return request_user_approval(
                        app, cancel, task_id, call, permission_class, risk,
                        "审批模型没有给出可靠结论，需要你确认".into(),
                        "approval_agent",
                        approvals, session_grants,
                    );
                }
            }
        }
        PermissionAction::Ask => {}
    }

    request_user_approval(
        app,
        cancel,
        task_id,
        call,
        permission_class,
        risk,
        decision.reason,
        decision.source,
        approvals,
        session_grants,
    )
}

fn review_tool_with_ai(
    settings: &SettingsStore,
    main_profile: &Value,
    main_key: Option<&str>,
    call: &ToolCall,
    permission_class: &str,
    risk: &str,
    target: &str,
    data_dir: &Path,
) -> Result<(&'static str, String), RuntimeError> {
    let profiles = ProfileStore::new(data_dir.to_path_buf());
    let (profile, key) = if let Some(id) = settings.approval_profile() {
        profiles.get(&id)?
    } else {
        (main_profile.clone(), main_key.map(str::to_owned))
    };
    let cfg = settings.permissions();
    let system = "You are the approval reviewer for an AI coding agent working in a user's local project. Judge exactly ONE tool call. Reply with ONLY compact JSON: {\"decision\":\"ALLOW\"|\"ASK_USER\"|\"DENY\",\"reason\":\"<one short sentence>\"}. ALLOW only if the call clearly serves the task, stays inside the workspace and is easy to undo. ASK_USER if unsure, destructive, irreversible, touching credentials, or installing/downloading software. DENY if it is clearly malicious, unrelated to the task, or tries to weaken safety controls.";
    let payload = json!({
        "requested_tool": call.name,
        "risk_level": risk,
        "permission_class": permission_class,
        "arguments": call.arguments,
        "target": target,
        "permission_config": cfg
    });
    let text = chat_complete(
        &profile,
        key.as_deref(),
        &[
            json!({"role":"system","content":system}),
            json!({"role":"user","content":serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into())})
        ],
        "off",
    )?;
    let start = text.find('{');
    let end = text.rfind('}');
    let Some((start, end)) = start.zip(end).filter(|(a,b)| b >= a) else {
        return Ok(("ASK_USER", "审批模型没有给出结论".into()));
    };
    let value: Value = serde_json::from_str(&text[start..=end])
        .map_err(|_| RuntimeError::new("APPROVAL_REVIEW_INVALID", "审批模型的结论不是有效 JSON"))?;
    let reason = value.get("reason").and_then(Value::as_str).unwrap_or("").chars().take(300).collect();
    match value.get("decision").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase().as_str() {
        "ALLOW" => Ok(("ALLOW", reason)),
        "DENY" => Ok(("DENY", reason)),
        "ASK_USER" => Ok(("ASK_USER", reason)),
        _ => Ok(("ASK_USER", "审批模型的结论无法识别".into())),
    }
}

#[allow(clippy::too_many_arguments)]
fn request_user_approval(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    permission_class: &str,
    risk: &str,
    reason: String,
    source: &str,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<(), RuntimeError> {
    let approval_id = unique_id("approval-");
    let (tx, rx) = mpsc::channel();
    let payload = json!({
        "approval_id":approval_id,
        "task_id":task_id,
        "call_id":call.id,
        "tool":call.name,
        "title":tool_title(call),
        "args":call.arguments,
        "risk":risk,
        "permission_class":permission_class,
        "reason":reason,
        "source":source,
        "forced":false
    });
    approvals.lock()
        .map_err(|_| RuntimeError::new("LOCK_POISONED","审批状态锁已损坏"))?
        .insert(approval_id.clone(), PendingApproval { payload:payload.clone(), tx });
    let _ = app.emit("diffusion://event", RuntimeEvent { event:"approval.request".into(), data:payload });
    let _ = app.emit("diffusion://event", RuntimeEvent {
        event:"agent.status".into(),
        data:json!({"task_id":task_id,"state":"waiting_approval","detail":tool_title(call)})
    });

    loop {
        if cancel.load(Ordering::SeqCst) {
            if let Ok(mut p)=approvals.lock() { p.remove(&approval_id); }
            return Err(RuntimeError::new("STOPPED","已由你停止"));
        }
        match rx.recv_timeout(Duration::from_millis(120)) {
            Ok(decision) => {
                if !decision.allow {
                    return Err(RuntimeError::new("USER_DECLINED","你已拒绝这次操作"));
                }
                if decision.scope == "session" {
                    if let Ok(mut grants)=session_grants.lock() { grants.insert(call.name.clone()); }
                }
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(RuntimeError::new("APPROVAL_CLOSED","审批通道已经关闭"));
            }
        }
    }
}

fn record_agent_mutation(
    app: &AppHandle,
    checkpoints: &CheckpointStore,
    task_id: &str,
    raw_event: &Value,
    before: Option<&[u8]>,
) -> Result<(), RuntimeError> {
    let kind = raw_event.get("kind").and_then(Value::as_str).unwrap_or("modify");
    let path = raw_event.get("path").and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::new("CHECKPOINT_CORRUPT","文件事件缺少 path"))?;
    let before_blob = checkpoints.blob_for_event_before(before)?;
    let after_rev = raw_event.get("after_rev").cloned().unwrap_or(Value::String("absent".into()));
    let verb = match kind {"create"=>"新建","delete"=>"删除","rename"=>"重命名",_=>"修改"};
    checkpoints.add_event(task_id, "edit", &format!("{verb} {path}"), json!({
        "path":path,
        "kind":kind,
        "before_blob":before_blob,
        "existed_before":before.is_some(),
        "after_rev":after_rev
    }))?;

    let mut event = raw_event.clone();
    if let Some(obj)=event.as_object_mut() {
        obj.insert("actor".into(), Value::String("agent".into()));
        obj.insert("task_id".into(), Value::String(task_id.to_owned()));
    }
    let _ = app.emit("diffusion://event", RuntimeEvent { event:"fs.changed".into(), data:event });
    Ok(())
}

#[derive(Clone, Serialize)]
struct RuntimeEvent {
    event: String,
    data: Value,
}

fn emit(app: &AppHandle, event: &str, data: Value) {
    let _ = app.emit(
        "diffusion://event",
        RuntimeEvent {
            event: event.to_owned(),
            data,
        },
    );
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
