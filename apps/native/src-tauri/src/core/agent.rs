use crate::core::checkpoint::CheckpointStore;
use crate::core::conversation::ConversationStore;
use crate::core::id::unique_id;
use crate::core::policy::{check_read_path, check_write_path};
use crate::core::provider::{agent_turn, chat_complete, ToolCall};
use crate::core::workspace::Workspace;
use crate::core::RuntimeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_TOOL_ROUNDS: usize = 12;
const MAX_TOOL_CALLS: usize = 32;
const MAX_AGENT_READ_BYTES: u64 = 8 * 1024 * 1024;

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
        workspace_root: PathBuf,
        data_dir: PathBuf,
        task_id: String,
        checkpoints: CheckpointStore,
    ) -> Result<Value, RuntimeError> {
        if !matches!(mode.as_str(), "chat" | "read" | "edit") {
            return Err(RuntimeError::new(
                "MIGRATION_PENDING",
                format!("Native Core 的「{mode}」模式仍在迁移；当前开放聊天、只读和编辑模式"),
            )
            .with_data(json!({"mode":mode,"available_modes":["chat","read","edit"]})));
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
                "chat" => "You are Diffusion IDE in CHAT mode. Converse naturally and ask the user when needed. You cannot inspect or modify project files and cannot execute commands.",
                "read" => "You are Diffusion IDE in READ-ONLY mode. Inspect the project with the provided tools before making factual claims about its code. You may list, read and search files, but cannot modify files, execute commands, access paths outside the workspace, or read secrets blocked by HardPolicy.",
                "edit" => "You are Diffusion IDE in EDIT mode. Inspect files before modifying them. You may list, read and search files, then request guarded file edits using the provided tools. Every write is subject to HardPolicy, permission policy and Checkpoint. Never bypass a denied action and never edit Git/Diffusion internal metadata directly.",
                _ => "You are Diffusion IDE.",
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

            let outcome = if matches!(mode.as_str(), "read" | "edit") {
                run_tool_mode(
                    &app,
                    &cancel,
                    &task_id,
                    &profile,
                    api_key.as_deref(),
                    messages,
                    &reasoning,
                    &workspace_root,
                    &data_dir,
                    &checkpoints,
                    mode == "edit",
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
    workspace_root: &Path,
    data_dir: &Path,
    checkpoints: &CheckpointStore,
    editable: bool,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<String, RuntimeError> {
    let tools = if editable { edit_tool_specs() } else { read_tool_specs() };
    let workspace = Workspace::open(&workspace_root.to_string_lossy(), data_dir)?;
    let mut read_revisions: HashMap<String, String> = HashMap::new();
    let mut visible = String::new();
    let mut total_calls = 0usize;

    for _round in 0..MAX_TOOL_ROUNDS {
        ensure_not_cancelled(cancel)?;
        emit(
            app,
            "agent.status",
            json!({"task_id":task_id,"state":"thinking","detail":""}),
        );
        let turn = agent_turn(profile, api_key, &messages, &tools, reasoning)?;
        ensure_not_cancelled(cancel)?;

        if !turn.text.is_empty() {
            emit(
                app,
                "agent.message",
                json!({"task_id":task_id,"delta":turn.text.clone()}),
            );
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
            if total_calls > MAX_TOOL_CALLS {
                return Err(RuntimeError::new(
                    "TOOL_LIMIT",
                    "只读智能体调用工具次数过多，已停止以避免无限循环",
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
                execute_ask_user(app, cancel, task_id, &call, questions.clone())
            } else if matches!(call.name.as_str(), "fs_write" | "fs_patch" | "fs_create" | "fs_delete" | "fs_rename" | "fs_copy") {
                if !editable {
                    Err(RuntimeError::new("UNKNOWN_TOOL", "当前模式没有写入工具"))
                } else {
                    execute_edit_tool(
                        app,
                        cancel,
                        task_id,
                        &workspace,
                        checkpoints,
                        &call,
                        &mut read_revisions,
                        approvals.clone(),
                        session_grants.clone(),
                    )
                }
            } else {
                execute_read_tool(workspace_root, &call)
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
                    }
                    let summary = match call.name.as_str() {
                        "fs_read" => format!("{} 行", value.get("total_lines").and_then(Value::as_u64).unwrap_or(0)),
                        "fs_list" => format!("{} 条结果", value.get("entries").and_then(Value::as_array).map(Vec::len).unwrap_or(0)),
                        "fs_search" => format!("{} 条结果", value.get("matches").and_then(Value::as_array).map(Vec::len).unwrap_or(0)),
                        "fs_write" | "fs_patch" | "fs_create" | "fs_delete" | "fs_rename" | "fs_copy" => "已修改".to_owned(),
                        "ask_user" => "已回答".to_owned(),
                        _ => "完成".to_owned(),
                    };
                    if matches!(call.name.as_str(), "fs_read" | "fs_list" | "fs_search") {
                        let _ = checkpoints.add_event(
                            task_id,
                            "read",
                            &tool_title(&call),
                            json!({"tool":call.name.clone(),"arguments":call.arguments.clone(),"summary":summary.clone()}),
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
        "ask_user" => "向你提问".to_owned(),
        _ => call.name.clone(),
    }
}

fn execute_read_tool(root: &Path, call: &ToolCall) -> Result<Value, RuntimeError> {
    match call.name.as_str() {
        "fs_list" => {
            let raw = call.arguments.get("path").and_then(Value::as_str).unwrap_or(".");
            check_read_path(raw)?;
            let depth = call.arguments.get("depth").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4) as usize;
            let dir = resolve_inside(root, raw)?;
            if !dir.is_dir() {
                return Err(RuntimeError::new("NOT_A_FOLDER", format!("{raw} 不是文件夹")));
            }
            let mut entries = Vec::new();
            list_dir(root, &dir, depth, &mut entries)?;
            Ok(json!({"entries":entries}))
        }
        "fs_read" => {
            let raw = required_arg(&call.arguments, "path")?;
            check_read_path(raw)?;
            let path = resolve_inside(root, raw)?;
            if !path.is_file() {
                return Err(RuntimeError::new("NOT_FOUND", format!("{raw} 不是文件")));
            }
            let meta = fs::metadata(&path)
                .map_err(|e| RuntimeError::new("READ_FAILED", format!("{raw}: {e}")))?;
            if meta.len() > MAX_AGENT_READ_BYTES {
                return Err(RuntimeError::new("TOO_LARGE", format!("{raw} 超过 8 MiB 读取上限")));
            }
            let data = fs::read(&path)
                .map_err(|e| RuntimeError::new("READ_FAILED", format!("{raw}: {e}")))?;
            if data[..data.len().min(4096)].contains(&0) {
                return Ok(json!({"path":display_rel(root,&path),"binary":true,"size":data.len()}));
            }
            let text = std::str::from_utf8(&data)
                .map_err(|_| RuntimeError::new("BINARY_FILE", format!("{raw} 不是 UTF-8 文本文件")))?;
            let lines = text.split('\n').collect::<Vec<_>>();
            let start = call.arguments.get("start_line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
            let end = call.arguments.get("end_line").and_then(Value::as_u64).unwrap_or(lines.len() as u64).max(1) as usize;
            let start = start.min(lines.len().max(1));
            let end = end.min(lines.len()).max(start);
            let content = if call.arguments.get("start_line").is_some() || call.arguments.get("end_line").is_some() {
                (start..=end)
                    .map(|n| format!("{n}: {}", lines.get(n - 1).copied().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                text.to_owned()
            };
            Ok(json!({
                "path":display_rel(root,&path),
                "revision": crate::core::crypto::sha256_hex(&data),
                "total_lines":lines.len(),
                "range":[start,end],
                "content":content
            }))
        }
        "fs_search" => {
            let query = required_arg(&call.arguments, "query")?;
            if query.is_empty() {
                return Err(RuntimeError::new("BAD_QUERY", "搜索内容不能为空"));
            }
            let case_sensitive = call.arguments.get("case_sensitive").and_then(Value::as_bool).unwrap_or(false);
            let max_results = call.arguments.get("max_results").and_then(Value::as_u64).unwrap_or(100).clamp(1, 200) as usize;
            let mut matches = Vec::new();
            let mut scanned = 0usize;
            search_dir(root, root, query, case_sensitive, max_results, &mut matches, &mut scanned)?;
            Ok(json!({"matches":matches,"files_scanned":scanned,"truncated":matches.len() >= max_results}))
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
            "name":"fs_delete","description":"Delete a FILE by moving it to Diffusion Trash. Directory deletion is intentionally not exposed to the agent. Requires user approval.",
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

#[allow(clippy::too_many_arguments)]
fn execute_edit_tool(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    workspace: &Workspace,
    checkpoints: &CheckpointStore,
    call: &ToolCall,
    read_revisions: &mut HashMap<String, String>,
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

    request_write_approval(
        app, cancel, task_id, call, approvals, session_grants
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

fn request_write_approval(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    call: &ToolCall,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    session_grants: Arc<Mutex<HashSet<String>>>,
) -> Result<(), RuntimeError> {
    if session_grants.lock().map(|g| g.contains(&call.name)).unwrap_or(false) {
        return Ok(());
    }

    let approval_id = unique_id("approval-");
    let (tx, rx) = mpsc::channel();
    let payload = json!({
        "approval_id":approval_id,
        "task_id":task_id,
        "call_id":call.id,
        "tool":call.name,
        "title":tool_title(call),
        "args":call.arguments,
        "risk": if matches!(call.name.as_str(),"fs_delete"|"fs_rename") {"high"} else {"medium"},
        "permission_class":"files.write",
        "reason":"智能体将修改工作区文件。Diffusion 会先写入 Checkpoint，以便你随后撤销。",
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
                    return Err(RuntimeError::new("USER_DECLINED","你已拒绝这次文件修改"));
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
