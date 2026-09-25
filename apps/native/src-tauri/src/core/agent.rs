use crate::core::conversation::ConversationStore;
use crate::core::id::unique_id;
use crate::core::provider::chat_complete;
use crate::core::RuntimeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

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
    pub fn start_chat(
        &self,
        app: AppHandle,
        store: ConversationStore,
        profile: Value,
        api_key: Option<String>,
        goal: String,
        conversation_id: Option<String>,
        reasoning: String,
    ) -> Result<Value, RuntimeError> {
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
            messages.push(json!({"role": "user", "content": goal.clone()}));

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
            json!({"task_id": task_id.clone(), "goal": goal.clone(), "mode": "chat"}),
        );
        emit(
            &app,
            "agent.status",
            json!({"task_id": return_task.clone(), "state": "thinking", "detail": ""}),
        );

        thread::spawn(move || {
            let finish = |status: &str, summary: String| {
                emit(
                    &app,
                    "agent.done",
                    json!({"task_id": task_id.clone(), "status": status, "summary": summary.clone()}),
                );
                emit(
                    &app,
                    "agent.status",
                    json!({
                        "task_id": task_id.clone(),
                        "state": if status == "error" { "error" } else if status == "stopped" { "stopped" } else { "idle" },
                        "detail": if status == "error" { summary.clone() } else { String::new() }
                    }),
                );
                running.store(false, Ordering::SeqCst);
                if let Ok(mut slot) = task_slot.lock() {
                    *slot = None;
                }
            };

            if cancel.load(Ordering::SeqCst) {
                let _ = store.append(
                    &conversation,
                    vec![json!({"role":"user","text":goal.clone(),"ts":now_secs()}), json!({"role":"note","text":"任务已停止","task_id":task_id.clone(),"status":"stopped","ts":now_secs()})],
                );
                finish("stopped", "已由你停止".into());
                return;
            }

            match chat_complete(&profile, api_key.as_deref(), &messages, &reasoning) {
                Ok(answer) => {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = store.append(
                            &conversation,
                            vec![
                                json!({"role":"user","text":goal,"ts":now_secs()}),
                                json!({"role":"note","text":"任务已停止","task_id":task_id,"status":"stopped","ts":now_secs()})
                            ],
                        );
                        finish("stopped", "已由你停止".into());
                        return;
                    }
                    emit(
                        &app,
                        "agent.message",
                        json!({"task_id": task_id.clone(), "delta": answer.clone()}),
                    );
                    emit(&app, "agent.turn_end", json!({"task_id": task_id.clone()}));
                    let _ = store.append(
                        &conversation,
                        vec![
                            json!({"role":"user","text":goal,"ts":now_secs()}),
                            json!({"role":"assistant","text":answer.clone(),"ts":now_secs()}),
                            json!({"role":"note","text":"任务完成","task_id":task_id.clone(),"status":"done","ts":now_secs()})
                        ],
                    );
                    finish("done", answer);
                }
                Err(error) => {
                    emit(
                        &app,
                        "agent.message",
                        json!({"task_id": task_id.clone(), "delta": format!("\n\n{}", error.message)}),
                    );
                    emit(&app, "agent.turn_end", json!({"task_id": task_id}));
                    let _ = store.append(
                        &conversation,
                        vec![
                            json!({"role":"user","text":goal,"ts":now_secs()}),
                            json!({"role":"note","text":"任务失败","task_id":task_id.clone(),"status":"error","ts":now_secs()})
                        ],
                    );
                    finish("error", error.message.clone());
                }
            }
        });

        Ok(json!({
            "task_id": return_task,
            "conversation_id": return_conversation
        }))
    }
}

#[derive(Serialize)]
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
