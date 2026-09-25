use crate::core::conversation::ConversationStore;
use crate::core::id::unique_id;
use crate::core::policy::check_read_path;
use crate::core::provider::{agent_turn, chat_complete, ToolCall};
use crate::core::RuntimeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_TOOL_ROUNDS: usize = 12;
const MAX_TOOL_CALLS: usize = 32;
const MAX_AGENT_READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct AgentState {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    task_id: Arc<Mutex<Option<String>>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            task_id: Arc::new(Mutex::new(None)),
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
        workspace_root: PathBuf,
    ) -> Result<Value, RuntimeError> {
        if !matches!(mode.as_str(), "chat" | "read") {
            return Err(RuntimeError::new(
                "MIGRATION_PENDING",
                format!("Native Core 的「{mode}」模式仍在迁移；alpha.5 当前开放聊天和只读模式"),
            )
            .with_data(json!({"mode":mode,"available_modes":["chat","read"]})));
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(RuntimeError::new("AGENT_BUSY", "已有一个 AI 任务正在运行"));
        }
        self.cancel.store(false, Ordering::SeqCst);

        let result = (|| {
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
            if mode == "read" {
                messages.insert(
                    0,
                    json!({
                        "role":"system",
                        "content":"You are Diffusion IDE in READ-ONLY mode. Inspect the project with the provided tools before making factual claims about its code. You may list directories, read text files, and search text. You cannot modify files, execute commands, access paths outside the workspace, or read secrets blocked by HardPolicy. If a tool is denied, do not try to bypass the policy. Give a concise final answer grounded in what you actually inspected."
                    }),
                );
            }

            let task_id = unique_id("task-");
            if let Ok(mut slot) = self.task_id.lock() {
                *slot = Some(task_id.clone());
            }
            Ok((conversation, task_id, messages))
        })();

        let (conversation, task_id, messages) = match result {
            Ok(value) => value,
            Err(error) => {
                self.running.store(false, Ordering::SeqCst);
                if let Ok(mut slot) = self.task_id.lock() {
                    *slot = None;
                }
                return Err(error);
            }
        };

        let running = self.running.clone();
        let cancel = self.cancel.clone();
        let task_slot = self.task_id.clone();
        let return_conversation = conversation.clone();
        let return_task = task_id.clone();

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

            let outcome = if mode == "read" {
                run_read_mode(
                    &app,
                    &cancel,
                    &task_id,
                    &profile,
                    api_key.as_deref(),
                    messages,
                    &reasoning,
                    &workspace_root,
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

fn run_read_mode(
    app: &AppHandle,
    cancel: &AtomicBool,
    task_id: &str,
    profile: &Value,
    api_key: Option<&str>,
    mut messages: Vec<Value>,
    reasoning: &str,
    workspace_root: &Path,
) -> Result<String, RuntimeError> {
    let tools = read_tool_specs();
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

            let result = execute_read_tool(workspace_root, &call);
            let (payload, state, summary, detail) = match result {
                Ok(value) => (value, "done", "完成".to_owned(), String::new()),
                Err(error) if matches!(error.code.as_str(), "SENSITIVE_PATH" | "OUTSIDE_WORKSPACE") => (
                    json!({"error":{"code":error.code,"message":error.message}}),
                    "denied",
                    "已拒绝".into(),
                    error.message,
                ),
                Err(error) => (
                    json!({"error":{"code":error.code,"message":error.message}}),
                    "error",
                    "失败".into(),
                    error.message,
                ),
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
        if matches!(name.as_str(), "node_modules" | "target" | ".gradle" | ".idea" | "__pycache__" | ".venv" | "venv") {
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
