use crate::core::workspace::Workspace;
use crate::core::RuntimeError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::process::Command;

fn git_error(text: impl Into<String>) -> RuntimeError {
    let text = text.into();
    let friendly = [
        ("not a git repository", "这个文件夹还不是 Git 仓库"),
        ("Please tell me who you are", "请先配置 git 的用户名和邮箱"),
        ("nothing to commit", "没有可提交的改动"),
        ("no changes added to commit", "没有已暂存的改动可提交"),
        ("could not read Username", "需要账号密码才能访问远程仓库，请先配置凭据"),
        ("Authentication failed", "远程仓库认证失败"),
        ("non-fast-forward", "远程有新的提交，请先拉取"),
        ("Not possible to fast-forward", "无法快进合并，请手动处理冲突"),
        ("has no upstream branch", "当前分支还没有关联远程分支"),
        ("already exists", "该分支已存在"),
        ("did not match any", "找不到这个分支或路径"),
    ];
    for (needle, message) in friendly {
        if text.contains(needle) {
            return RuntimeError::new("GIT_ERROR", message);
        }
    }
    RuntimeError::new(
        "GIT_ERROR",
        if text.trim().is_empty() { "Git 操作失败".to_owned() } else { text.chars().take(600).collect::<String>() },
    )
}

fn run(root: &Path, args: &[&str], check: bool) -> Result<String, RuntimeError> {
    let output = Command::new("git")
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_PAGER", "cat")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                RuntimeError::new("NO_GIT", "当前系统没有可用的 Git 后端")
            } else {
                RuntimeError::new("GIT_ERROR", e.to_string())
            }
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if check && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(git_error(if stderr.trim().is_empty() { stdout } else { stderr }));
    }
    Ok(stdout)
}

fn run_bytes(root: &Path, args: &[&str], check: bool) -> Result<Vec<u8>, RuntimeError> {
    let output = Command::new("git")
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_PAGER", "cat")
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound {
            RuntimeError::new("NO_GIT", "当前系统没有可用的 Git 后端")
        } else { RuntimeError::new("GIT_ERROR", e.to_string()) })?;
    if check && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        return Err(git_error(if stderr.trim().is_empty() { stdout } else { stderr }));
    }
    Ok(output.stdout)
}

fn safe_rel(raw: &str) -> Result<String, RuntimeError> {
    if raw.is_empty() || raw.starts_with('-') {
        return Err(RuntimeError::new("BAD_GIT_PATH", "Git 路径无效"));
    }
    let p = Path::new(raw);
    if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err(RuntimeError::new("OUTSIDE_WORKSPACE", "Git 路径不能离开工作区"));
    }
    Ok(raw.replace('\\', "/"))
}

pub fn status(root: &Path) -> Result<Value, RuntimeError> {
    let inside = run(root, &["rev-parse", "--is-inside-work-tree"], false)?;
    if inside.trim() != "true" {
        return Ok(json!({"is_repo":false,"files":[],"branch":null}));
    }
    let out = run(root, &["status", "--porcelain=v1", "-b", "--untracked-files=all"], true)?;
    let mut branch = String::new();
    let mut upstream: Option<String> = None;
    let mut ahead = 0u64;
    let mut behind = 0u64;
    let mut files = Vec::new();
    for line in out.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            if let Some(rest) = head.strip_prefix("No commits yet on ") {
                branch = rest.to_owned();
            } else if head.starts_with("HEAD (no branch)") {
                branch = "（游离 HEAD）".into();
            } else {
                let (name, rest) = head.split_once("...").unwrap_or((head, ""));
                branch = name.to_owned();
                if !rest.is_empty() {
                    let (up, tail) = rest.split_once(" [").unwrap_or((rest, ""));
                    upstream = Some(up.to_owned());
                    for part in tail.trim_end_matches(']').split(", ") {
                        if let Some(n)=part.strip_prefix("ahead ") { ahead=n.parse().unwrap_or(0); }
                        if let Some(n)=part.strip_prefix("behind ") { behind=n.parse().unwrap_or(0); }
                    }
                }
            }
            continue;
        }
        if line.len() < 3 { continue; }
        let bytes=line.as_bytes();
        let index=bytes[0] as char;
        let worktree=bytes[1] as char;
        let mut path=line[3..].to_owned();
        let mut orig=Value::Null;
        if matches!(index,'R'|'C') {
            if let Some((a,b))=path.split_once(" -> ") {
                orig=Value::String(a.to_owned());
                path=b.to_owned();
            }
        }
        files.push(json!({"path":path,"index":index.to_string(),"worktree":worktree.to_string(),"orig":orig}));
    }
    Ok(json!({"is_repo":true,"branch":branch,"upstream":upstream,"ahead":ahead,"behind":behind,"files":files}))
}

pub fn diff(root:&Path,path:&str,staged:bool)->Result<Value,RuntimeError>{
    let rel=safe_rel(path)?;
    let st=status(root)?;
    let untracked=st.get("files").and_then(Value::as_array).into_iter().flatten().any(|f|
        f.get("path").and_then(Value::as_str)==Some(rel.as_str()) && f.get("index").and_then(Value::as_str)==Some("?"));
    if untracked && !staged {
        let text=fs::read_to_string(root.join(&rel)).map_err(|e|RuntimeError::new("GIT_ERROR",e.to_string()))?;
        let body=text.split('\n').take(2000).map(|l|format!("+{l}\n")).collect::<String>();
        return Ok(json!({"diff":format!("新文件 {rel}\n@@ -0,0 +1,{} @@\n{body}",text.lines().count())}));
    }
    let mut args=vec!["diff","--no-color"];
    if staged { args.push("--cached"); }
    args.extend(["--",rel.as_str()]);
    let out=run(root,&args,true)?;
    Ok(json!({"diff":out.chars().take(200_000).collect::<String>()}))
}

pub fn stage(root:&Path,paths:&[String])->Result<Value,RuntimeError>{
    let safe=paths.iter().map(|p|safe_rel(p)).collect::<Result<Vec<_>,_>>()?;
    let mut owned=vec!["add".to_owned(),"--".to_owned()]; owned.extend(safe);
    let refs=owned.iter().map(String::as_str).collect::<Vec<_>>();
    run(root,&refs,true)?; Ok(json!({}))
}
pub fn unstage(root:&Path,paths:&[String])->Result<Value,RuntimeError>{
    let safe=paths.iter().map(|p|safe_rel(p)).collect::<Result<Vec<_>,_>>()?;
    let mut owned=vec!["restore".to_owned(),"--staged".to_owned(),"--".to_owned()]; owned.extend(safe.clone());
    let refs=owned.iter().map(String::as_str).collect::<Vec<_>>();
    if run(root,&refs,true).is_err() {
        let mut owned=vec!["rm".to_owned(),"--cached".to_owned(),"-r".to_owned(),"-q".to_owned(),"--".to_owned()]; owned.extend(safe);
        let refs=owned.iter().map(String::as_str).collect::<Vec<_>>();
        run(root,&refs,true)?;
    }
    Ok(json!({}))
}

pub fn discard(workspace:&Workspace,path:&str,confirm:bool)->Result<(Value,Vec<Value>),RuntimeError>{
    if !confirm { return Err(RuntimeError::new("NEEDS_CONFIRM","丢弃改动需要明确确认")); }
    let root=workspace.local_root_path().ok_or_else(|| RuntimeError::new("WORKSPACE_CAPABILITY", "Git 需要本地文件系统工作区；Android SAF 原地项目请复制到 Diffusion 私有工作区后再使用 Git"))?;
    let rel=safe_rel(path)?;
    let st=status(&root)?;
    let entry=st.get("files").and_then(Value::as_array).into_iter().flatten().find(|f|f.get("path").and_then(Value::as_str)==Some(rel.as_str()));
    if entry.and_then(|f|f.get("index")).and_then(Value::as_str)==Some("?") {
        let m=workspace.delete(&rel)?;
        return Ok((json!({}),vec![m.event]));
    }
    run(&root,&["restore","--",rel.as_str()],true)?;
    Ok((json!({}),vec![json!({"kind":"modify","path":rel,"actor":"git","task_id":null})]))
}

pub fn commit(root:&Path,message:&str)->Result<Value,RuntimeError>{
    if message.trim().is_empty(){return Err(RuntimeError::new("GIT_ERROR","提交说明不能为空"));}
    run(root,&["commit","-m",message.trim()],true)?;
    let hash=run(root,&["rev-parse","--short","HEAD"],true)?.trim().to_owned();
    Ok(json!({"hash":hash}))
}
pub fn branches(root:&Path)->Result<Value,RuntimeError>{
    let out=run(root,&["branch","--format=%(refname:short)\t%(HEAD)"],false)?;
    let branches=out.lines().filter_map(|l|l.split_once('\t')).map(|(n,h)|json!({"name":n,"current":h.trim()=="*"})).collect::<Vec<_>>();
    Ok(json!({"branches":branches}))
}
pub fn checkout(root:&Path,name:&str,create:bool)->Result<Value,RuntimeError>{
    if name.trim().is_empty()||name.starts_with('-'){return Err(RuntimeError::new("GIT_ERROR","分支名无效"));}
    if create { run(root,&["switch","-c",name],true)?; } else { run(root,&["switch",name],true)?; }
    Ok(json!({}))
}
pub fn log(root:&Path,limit:u64,path:Option<&str>)->Result<Value,RuntimeError>{
    let limit=limit.clamp(1,200).to_string();
    let mut owned=vec!["log".to_owned(),format!("-n{limit}"),"--date=relative".into(),"--pretty=format:%h%x1f%an%x1f%ad%x1f%s".into()];
    if let Some(path)=path { owned.push("--".into()); owned.push(safe_rel(path)?); }
    let refs=owned.iter().map(String::as_str).collect::<Vec<_>>();
    let out=run(root,&refs,false)?;
    let commits=out.lines().filter_map(|l|{
        let p=l.split('\x1f').collect::<Vec<_>>();
        (p.len()==4).then(||json!({"hash":p[0],"author":p[1],"date":p[2],"subject":p[3]}))
    }).collect::<Vec<_>>();
    Ok(json!({"commits":commits}))
}
pub fn blame(root:&Path,path:&str)->Result<Value,RuntimeError>{
    let rel=safe_rel(path)?;
    let out=run(root,&["blame","--line-porcelain","--",rel.as_str()],true)?;
    let mut rows=Vec::new(); let mut hash=String::new(); let mut author=String::new();
    for line in out.lines(){
        if let Some(a)=line.strip_prefix("author "){author=a.to_owned();}
        else if line.starts_with('\t'){rows.push(json!({"hash":hash.chars().take(7).collect::<String>(),"author":author}));hash.clear();author.clear();}
        else if line.len()>40 && line.as_bytes().get(40)==Some(&b' ') && line[..40].bytes().all(|b|b.is_ascii_hexdigit()){hash=line[..40].to_owned();}
    }
    Ok(json!({"lines":rows}))
}
pub fn pull(root:&Path)->Result<Value,RuntimeError>{Ok(json!({"output":run(root,&["pull","--ff-only"],true)?.trim()}))}
pub fn push(root:&Path)->Result<Value,RuntimeError>{let s=run(root,&["push"],true)?;Ok(json!({"output":if s.trim().is_empty(){"已推送"}else{s.trim()}}))}
pub fn init(root:&Path)->Result<Value,RuntimeError>{run(root,&["init"],true)?;Ok(json!({}))}

fn resolve_commit(root:&Path,reference:&str)->Result<String,RuntimeError>{
    if reference.is_empty()||reference.starts_with('-'){return Err(RuntimeError::new("GIT_ERROR","提交版本无效"));}
    Ok(run(root,&["rev-parse","--verify",&format!("{reference}^{{commit}}")],true)?.trim().to_owned())
}
fn tracked_modes(root:&Path)->Result<HashMap<String,String>,RuntimeError>{
    let raw=run_bytes(root,&["ls-files","-s","-z"],false)?;
    let mut out=HashMap::new();
    for row in raw.split(|b|*b==0).filter(|r|!r.is_empty()){
        if let Some(pos)=row.iter().position(|b|*b==b'\t'){
            let meta=&row[..pos]; let path=&row[pos+1..];
            let mode=String::from_utf8_lossy(meta).split_whitespace().next().unwrap_or("").to_owned();
            out.insert(String::from_utf8_lossy(path).into_owned(),mode);
        }
    }
    Ok(out)
}
fn tree(root:&Path,reference:&str)->Result<BTreeMap<String,(String,String,String)>,RuntimeError>{
    let commit=resolve_commit(root,reference)?;
    let raw=run_bytes(root,&["ls-tree","-r","-z",&commit],true)?;
    let mut out=BTreeMap::new();
    for row in raw.split(|b|*b==0).filter(|r|!r.is_empty()){
        if let Some(pos)=row.iter().position(|b|*b==b'\t'){
            let meta=String::from_utf8_lossy(&row[..pos]);
            let p=meta.split_whitespace().collect::<Vec<_>>();
            if p.len()==3 { out.insert(String::from_utf8_lossy(&row[pos+1..]).into_owned(),(p[0].into(),p[1].into(),p[2].into())); }
        }
    }
    Ok(out)
}
fn blob(root:&Path,sha:&str)->Result<Vec<u8>,RuntimeError>{run_bytes(root,&["cat-file","blob",sha],true)}

pub fn reset(workspace:&Workspace,reference:&str,mode:&str,confirm:bool)->Result<(Value,Vec<Value>),RuntimeError>{
    let root=workspace.local_root_path().ok_or_else(|| RuntimeError::new("WORKSPACE_CAPABILITY", "Git 需要本地文件系统工作区；Android SAF 原地项目请复制到 Diffusion 私有工作区后再使用 Git"))?;
    let commit=resolve_commit(&root,reference)?;
    if mode=="soft" {
        run(&root,&["reset","--soft",&commit],true)?;
        return Ok((json!({"hash":commit,"mode":"soft"}),vec![]));
    }
    if mode!="hard" {return Err(RuntimeError::new("GIT_ERROR","回退方式只能是 soft 或 hard"));}
    if !confirm {return Err(RuntimeError::new("NEEDS_CONFIRM","强制回退会恢复工作区文件，需要明确确认"));}
    let target=tree(&root,&commit)?;
    let current=tracked_modes(&root)?;
    for (path,(m,t,_)) in &target {
        if t!="blob"||matches!(m.as_str(),"120000"|"160000"){return Err(RuntimeError::new("GIT_UNSUPPORTED_ENTRY",format!("{path} 是符号链接或子模块，图形界面暂不能安全回退")));}
    }
    for (path,m) in &current {
        if matches!(m.as_str(),"120000"|"160000"){return Err(RuntimeError::new("GIT_UNSUPPORTED_ENTRY",format!("{path} 是符号链接或子模块，图形界面暂不能安全回退")));}
    }
    let mut events=Vec::new();
    for path in current.keys().filter(|p|!target.contains_key(*p)) {
        let abs=root.join(path);
        if abs.exists() {
            let m=workspace.delete(path)?;
            events.push(m.event);
        }
    }
    for (path,(mode,_,sha)) in &target {
        let abs=root.join(path);
        if let Ok(meta)=fs::symlink_metadata(&abs) {
            if meta.file_type().is_symlink(){return Err(RuntimeError::new("GIT_UNSUPPORTED_ENTRY",format!("{path} 当前是符号链接，无法安全回退")));}
        }
        let bytes=blob(&root,sha)?;
        let mut needs=true;
        if abs.is_file(){ if let Ok(now)=fs::read(&abs){needs=now!=bytes;} }
        if abs.exists() && (abs.is_dir()||needs) {
            let m=workspace.delete(path)?;
            events.push(m.event);
        }
        if needs || !abs.exists() {
            let m=workspace.write_bytes_protected(path,&bytes,None)?;
            events.push(m.event);
        }
        workspace.set_executable_protected(path,mode=="100755")?;
    }
    run(&root,&["reset","--mixed",&commit],true)?;
    Ok((json!({"hash":commit,"mode":"hard"}),events))
}
