use crate::core::id::unique_id;
use crate::core::RuntimeError;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MAX_SESSIONS: usize = 8;
const MAX_HISTORY: usize = 200_000;
const MAX_CAPTURE: usize = 60_000;

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

#[derive(Clone)]
pub struct TerminalManager {
    commands: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    #[cfg(not(target_os = "android"))]
    sessions: Arc<Mutex<HashMap<String, Arc<PtySession>>>>,
    last_session: Arc<Mutex<Option<String>>>,
}

#[cfg(not(target_os = "android"))]
struct PtySession {
    id: String,
    pid: Option<u32>,
    shell: String,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    history: Mutex<String>,
    alive: AtomicBool,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            commands: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(not(target_os = "android"))]
            sessions: Arc::new(Mutex::new(HashMap::new())),
            last_session: Arc::new(Mutex::new(None)),
        }
    }

    pub fn run(&self, app: &AppHandle, cwd: &Path, command: &str, timeout_seconds: f64) -> Result<Value, RuntimeError> {
        if command.trim().is_empty() {
            return Err(RuntimeError::new("BAD_COMMAND", "命令不能为空"));
        }
        let id = unique_id("cmd-");
        let mut cmd = shell_command(command);
        cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| RuntimeError::new("PROCESS_START_FAILED", format!("无法启动命令：{e}")))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let shared = Arc::new(Mutex::new(child));
        self.commands
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "命令状态锁已损坏"))?
            .insert(id.clone(), shared.clone());

        emit(app, "terminal.start", json!({"source":"user","id":id,"command":command}));
        if let Some(out) = stdout {
            stream_pipe(app.clone(), id.clone(), "stdout", out);
        }
        if let Some(err) = stderr {
            stream_pipe(app.clone(), id.clone(), "stderr", err);
        }

        let app2 = app.clone();
        let id2 = id.clone();
        let commands = self.commands.clone();
        let timeout = Duration::from_secs_f64(timeout_seconds.clamp(1.0, 3600.0));
        thread::spawn(move || {
            let started = Instant::now();
            let exit_code = loop {
                let status = shared.lock().ok().and_then(|mut child| child.try_wait().ok().flatten());
                if let Some(status) = status {
                    break status.code().unwrap_or(-1);
                }
                if started.elapsed() >= timeout {
                    if let Ok(mut child) = shared.lock() {
                        let _ = child.kill();
                    }
                    break -1;
                }
                thread::sleep(Duration::from_millis(50));
            };
            if let Ok(mut map) = commands.lock() {
                map.remove(&id2);
            }
            emit(&app2, "terminal.exit", json!({"source":"user","id":id2,"exit_code":exit_code}));
        });

        Ok(json!({"id":id}))
    }

    pub fn kill(&self, id: &str) -> Result<Value, RuntimeError> {
        if let Some(child) = self.commands.lock().ok().and_then(|m| m.get(id).cloned()) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
        Ok(json!({}))
    }

    #[cfg(target_os = "android")]
    pub fn open(&self, _app: &AppHandle, _cwd: &Path, _cols: u16, _rows: u16) -> Result<Value, RuntimeError> {
        Err(RuntimeError::new(
            "NO_PTY",
            "Android 原生壳当前不提供交互式 PTY；一次性命令模式仍可用",
        ))
    }

    #[cfg(not(target_os = "android"))]
    pub fn open(&self, app: &AppHandle, cwd: &Path, cols: u16, rows: u16) -> Result<Value, RuntimeError> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let alive = self.sessions
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "终端状态锁已损坏"))?
            .values()
            .filter(|s| s.alive.load(Ordering::SeqCst))
            .count();
        if alive >= MAX_SESSIONS {
            return Err(RuntimeError::new("TOO_MANY", format!("最多同时打开 {MAX_SESSIONS} 个终端")));
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| RuntimeError::new("NO_PTY", format!("无法创建 PTY：{e}")))?;

        let shell = interactive_shell();
        let mut command = CommandBuilder::new(&shell);
        command.cwd(cwd);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| RuntimeError::new("PROCESS_START_FAILED", format!("无法启动终端：{e}")))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| RuntimeError::new("NO_PTY", format!("无法读取 PTY：{e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| RuntimeError::new("NO_PTY", format!("无法写入 PTY：{e}")))?;

        let id = unique_id("pty-");
        let session = Arc::new(PtySession {
            id: id.clone(),
            pid,
            shell: shell.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            history: Mutex::new(String::new()),
            alive: AtomicBool::new(true),
        });
        self.sessions
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "终端状态锁已损坏"))?
            .insert(id.clone(), session.clone());
        if let Ok(mut last) = self.last_session.lock() {
            *last = Some(id.clone());
        }

        let app_reader = app.clone();
        let read_session = session.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                        append_history(&read_session.history, &text);
                        emit(&app_reader, "terminal.data", json!({"id":read_session.id,"data":text}));
                    }
                }
            }
        });

        let app_wait = app.clone();
        let wait_session = session.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
            wait_session.alive.store(false, Ordering::SeqCst);
            emit(
                &app_wait,
                "terminal.closed",
                json!({
                    "id":wait_session.id,
                    "exit_code":status.map(|s| s.exit_code()).unwrap_or(-1)
                }),
            );
        });

        Ok(json!({"id":id,"pid":pid,"shell":shell}))
    }

    #[cfg(target_os = "android")]
    pub fn input(&self, _id: &str, _data: &str) -> Result<Value, RuntimeError> {
        Err(RuntimeError::new("NO_PTY", "Android 当前没有交互式 PTY"))
    }

    #[cfg(not(target_os = "android"))]
    pub fn input(&self, id: &str, data: &str) -> Result<Value, RuntimeError> {
        let session = self.session(id)?;
        session
            .writer
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "终端写入锁已损坏"))?
            .write_all(data.as_bytes())
            .map_err(|e| RuntimeError::new("TERMINAL_WRITE_FAILED", e.to_string()))?;
        Ok(json!({}))
    }

    #[cfg(target_os = "android")]
    pub fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> Result<Value, RuntimeError> {
        Err(RuntimeError::new("NO_PTY", "Android 当前没有交互式 PTY"))
    }

    #[cfg(not(target_os = "android"))]
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<Value, RuntimeError> {
        let session = self.session(id)?;
        session
            .master
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "终端 PTY 锁已损坏"))?
            .resize(portable_pty::PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| RuntimeError::new("TERMINAL_RESIZE_FAILED", e.to_string()))?;
        Ok(json!({}))
    }

    pub fn close(&self, id: &str) -> Result<Value, RuntimeError> {
        #[cfg(target_os = "android")]
        {
            let _ = id;
            return Ok(json!({}));
        }
        #[cfg(not(target_os = "android"))]
        {
            let session = self.session(id)?;
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
            session.alive.store(false, Ordering::SeqCst);
            Ok(json!({}))
        }
    }

    pub fn list(&self) -> Value {
        #[cfg(target_os = "android")]
        {
            json!({"sessions":[]})
        }
        #[cfg(not(target_os = "android"))]
        {
            let sessions = self.sessions
                .lock()
                .ok()
                .map(|m| {
                    m.values()
                        .map(|s| json!({
                            "id":s.id,
                            "pid":s.pid,
                            "alive":s.alive.load(Ordering::SeqCst),
                            "shell":s.shell
                        }))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({"sessions":sessions})
        }
    }

    pub fn history(&self, id: &str) -> Result<Value, RuntimeError> {
        #[cfg(target_os = "android")]
        {
            let _ = id;
            Err(RuntimeError::new("NO_PTY", "Android 当前没有交互式 PTY"))
        }
        #[cfg(not(target_os = "android"))]
        {
            let session = self.session(id)?;
            let data = session.history.lock().map(|h| h.clone()).unwrap_or_default();
            Ok(json!({"data":data,"alive":session.alive.load(Ordering::SeqCst)}))
        }
    }

    pub fn last_history(&self) -> Option<(String, String)> {
        #[cfg(target_os = "android")]
        {
            None
        }
        #[cfg(not(target_os = "android"))]
        {
            let id = self.last_session.lock().ok().and_then(|x| x.clone())?;
            let session = self.sessions.lock().ok()?.get(&id)?.clone();
            let history = session.history.lock().ok()?.clone();
            Some((id, history))
        }
    }

    #[cfg(not(target_os = "android"))]
    fn session(&self, id: &str) -> Result<Arc<PtySession>, RuntimeError> {
        self.sessions
            .lock()
            .map_err(|_| RuntimeError::new("LOCK_POISONED", "终端状态锁已损坏"))?
            .get(id)
            .cloned()
            .ok_or_else(|| RuntimeError::new("NO_SUCH_TERMINAL", "这个终端已经不存在"))
    }
}

fn append_history(history: &Mutex<String>, text: &str) {
    if let Ok(mut history) = history.lock() {
        history.push_str(text);
        if history.len() > MAX_HISTORY {
            let remove = history.len() - MAX_HISTORY;
            let mut boundary = remove;
            while boundary < history.len() && !history.is_char_boundary(boundary) {
                boundary += 1;
            }
            history.drain(..boundary);
        }
    }
}

fn stream_pipe<R: Read + Send + 'static>(app: AppHandle, id: String, stream: &'static str, mut reader: R) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    emit(&app, "terminal.output", json!({"source":"user","id":id,"stream":stream,"data":text}));
                }
            }
        }
    });
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = if find_on_path("pwsh.exe").is_some() {
            let mut c = Command::new("pwsh.exe");
            c.args(["-NoProfile", "-Command", command]);
            c
        } else if find_on_path("powershell.exe").is_some() {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", command]);
            c
        } else {
            let mut c = Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()));
            c.args(["/C", command]);
            c
        };
        return cmd;
    }
    #[cfg(target_os = "android")]
    {
        let mut cmd = Command::new("/system/bin/sh");
        cmd.args(["-c", command]);
        cmd
    }
    #[cfg(all(unix, not(target_os = "android")))]
    {
        let shell = find_on_path("bash").or_else(|| find_on_path("sh")).unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let mut cmd = Command::new(shell);
        cmd.args(["-c", command]);
        cmd
    }
}

#[cfg(not(target_os = "android"))]
fn interactive_shell() -> String {
    #[cfg(windows)]
    {
        if find_on_path("pwsh.exe").is_some() {
            return "pwsh.exe".into();
        }
        if find_on_path("powershell.exe").is_some() {
            return "powershell.exe".into();
        }
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    }
    #[cfg(unix)]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty())
            .or_else(|| find_on_path("bash").map(|p| p.to_string_lossy().into_owned()))
            .or_else(|| find_on_path("sh").map(|p| p.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "/bin/sh".into())
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn listening_ports() -> Vec<Value> {
    #[cfg(any(target_os = "android", target_os = "linux"))]
    {
        let mut ports = BTreeSet::new();
        for (file, family) in [("/proc/net/tcp", "IPv4"), ("/proc/net/tcp6", "IPv6")] {
            if let Ok(text) = std::fs::read_to_string(file) {
                for line in text.lines().skip(1) {
                    let fields = line.split_whitespace().collect::<Vec<_>>();
                    if fields.len() < 4 || fields[3] != "0A" {
                        continue;
                    }
                    if let Some(hex) = fields[1].split(':').nth(1) {
                        if let Ok(port) = u16::from_str_radix(hex, 16) {
                            ports.insert((port, family));
                        }
                    }
                }
            }
        }
        return ports.into_iter().map(|(port,family)| json!({"port":port,"family":family})).collect();
    }
    #[cfg(windows)]
    {
        let out = Command::new("netstat").args(["-ano","-p","tcp"]).output().ok();
        let mut ports = BTreeSet::new();
        if let Some(out)=out {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let fields=line.split_whitespace().collect::<Vec<_>>();
                if fields.len() < 4 || fields[3] != "LISTENING" { continue; }
                if let Some(port)=fields[1].rsplit(':').next().and_then(|p|p.parse::<u16>().ok()) {
                    ports.insert(port);
                }
            }
        }
        return ports.into_iter().map(|port|json!({"port":port,"family":"TCP"})).collect();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

pub fn run_capture(
    cwd: &Path,
    command: &str,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<Value, RuntimeError> {
    if command.trim().is_empty() {
        return Err(RuntimeError::new("BAD_COMMAND", "命令不能为空"));
    }
    let mut cmd = shell_command(command);
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| RuntimeError::new("PROCESS_START_FAILED", format!("无法启动命令：{e}")))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let capture = Arc::new(Mutex::new(String::new()));
    for pipe in [stdout.map(Pipe::Stdout), stderr.map(Pipe::Stderr)].into_iter().flatten() {
        let out = capture.clone();
        thread::spawn(move || {
            let mut reader: Box<dyn Read + Send> = match pipe {
                Pipe::Stdout(r) => Box::new(r),
                Pipe::Stderr(r) => Box::new(r),
            };
            let mut buf=[0u8;4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0)|Err(_)=>break,
                    Ok(n)=>{
                        if let Ok(mut text)=out.lock() {
                            if text.len()<MAX_CAPTURE {
                                let remain=MAX_CAPTURE-text.len();
                                let piece=String::from_utf8_lossy(&buf[..n]);
                                text.extend(piece.chars().take(remain));
                            }
                        }
                    }
                }
            }
        });
    }
    let started=Instant::now();
    let (code,timed_out,cancelled)=loop {
        if cancel.load(Ordering::SeqCst) {
            let _=child.kill();
            break (-1,false,true);
        }
        if started.elapsed()>=timeout {
            let _=child.kill();
            break (-1,true,false);
        }
        if let Some(status)=child.try_wait().map_err(|e|RuntimeError::new("PROCESS_WAIT_FAILED",e.to_string()))? {
            break (status.code().unwrap_or(-1),false,false);
        }
        thread::sleep(Duration::from_millis(50));
    };
    let _=child.wait();
    thread::sleep(Duration::from_millis(30));
    let output=capture.lock().map(|s|s.clone()).unwrap_or_default();
    Ok(json!({"exit_code":code,"output":output,"timed_out":timed_out,"cancelled":cancelled}))
}

enum Pipe {
    Stdout(std::process::ChildStdout),
    Stderr(std::process::ChildStderr),
}
