use super::{crypto::sha256_hex, engineering, id::unique_id, policy::{check_read_path, check_write_path}, workspace::Workspace, RuntimeError};
use serde_json::{json, Value};
use std::{collections::{BTreeSet, BTreeMap}, fs, path::{Path, PathBuf}, process::Command};
fn err(code: &str, message: impl Into<String>) -> RuntimeError { RuntimeError::new(code, message) }
fn root(ws: &Workspace) -> Result<PathBuf, RuntimeError> { ws.local_root_path().ok_or_else(|| err("WORKSPACE_CAPABILITY", "SAF 工作区不支持 Git worktree")) }
fn git(root: &Path, args: &[&str], missing: bool) -> Result<Option<Vec<u8>>, RuntimeError> {
    let result = Command::new("git").args(["-c","core.hooksPath=/dev/null"]).args(args).current_dir(root).env("GIT_TERMINAL_PROMPT","0").env("GIT_PAGER","cat").output().map_err(|e| err("GIT_ERROR",e.to_string()))?;
    if !result.status.success() {
        if missing { return Ok(None); }
        return Err(err("GIT_ERROR",String::from_utf8_lossy(&result.stderr).chars().take(1000).collect::<String>()));
    }
    Ok(Some(result.stdout))
}
fn bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>, RuntimeError> { Ok(git(root,args,false)?.unwrap_or_default()) }
pub fn baseline(ws: &Workspace) -> Value {
    let Ok(root) = root(ws) else { return Value::Null; };
    let Ok(Some(commit)) = git(&root,&["rev-parse","HEAD"],true) else { return Value::Null; };
    let Ok(status) = bytes(&root,&["status","--porcelain","--untracked-files=all"]) else { return Value::Null; };
    json!({"commit":String::from_utf8_lossy(&commit).trim(),"clean":status.is_empty()})
}
fn location(data: &Path, id: &str) -> Result<PathBuf, RuntimeError> {
    if id.is_empty() || id.len()>80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-') { return Err(err("BAD_SANDBOX","沙箱编号无效")); }
    Ok(data.parent().ok_or_else(|| err("BAD_SANDBOX","无法创建沙箱目录"))?.join("koide-worktrees").join(id))
}
pub fn open(ws: &Workspace, data: &Path, id: &str) -> Result<(Workspace, Value), RuntimeError> {
    let saved = engineering::get(ws,"sandboxes")?;
    let record = saved["value"].as_array().and_then(|xs| xs.iter().find(|x| x["id"]==id)).cloned().ok_or_else(|| err("BAD_SANDBOX","当前项目没有这个沙箱"))?;
    let path = location(data,id)?;
    if !path.is_dir() || fs::symlink_metadata(&path).map_err(|e|err("BAD_SANDBOX",e.to_string()))?.file_type().is_symlink() { return Err(err("BAD_SANDBOX","沙箱目录不可用")); }
    Ok((Workspace::open(&path.to_string_lossy(),data)?,record))
}
pub fn create(ws: &Workspace, data: &Path, task_id: Option<&str>, seq: Option<usize>) -> Result<Value, RuntimeError> {
    let mut base = baseline(ws);
    if base["clean"] != true { return Err(err("SANDBOX_DIRTY","创建沙箱需要已提交且干净的 Git 工作区")); }
    let historical = if let Some(id) = task_id {
        let task = ws.checkpoint_task(id)?;
        let origin = task["events"].as_array().and_then(|es| es.iter().find(|e| e["type"]=="context")).map(|e| e["base_git"].clone()).unwrap_or(Value::Null);
        if origin["clean"] != true { return Err(err("HISTORY_UNAVAILABLE","任务没有干净的 Git 起点，不能完整恢复历史工作区")); }
        if seq.is_none() || seq.unwrap() >= task["events"].as_array().map(Vec::len).unwrap_or(0) { return Err(err("BAD_REQUEST","历史节点不存在")); }
        base = origin; Some(task)
    } else { None };
    let commit = base["commit"].as_str().ok_or_else(|| err("BAD_SANDBOX","缺少基准提交"))?;
    let main = root(ws)?;
    let listing = bytes(&main,&["ls-tree","-r",commit])?;
    if String::from_utf8_lossy(&listing).lines().any(|s| s.starts_with("120000") || s.starts_with("160000")) { return Err(err("WORKSPACE_CAPABILITY","包含符号链接或子模块的仓库暂不支持自动沙箱")); }
    let mut state = BTreeMap::new();
    if let Some(task)=&historical {
        for (p,f) in task["files"].as_object().into_iter().flatten() {state.insert(p.clone(),f["blob"].clone());}
        for e in task["events"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().take(seq.unwrap()+1) {
            if e["type"]=="edit" {if e.get("after_blob").is_none(){return Err(err("HISTORY_UNAVAILABLE","历史修改缺少固定快照"));}state.insert(e["path"].as_str().ok_or_else(||err("HISTORY_UNAVAILABLE","历史路径无效"))?.to_owned(),e["after_blob"].clone());}
        }
        for (p,blob) in &state {check_write_path(p)?;if let Some(sha)=blob.as_str(){ws.checkpoint_handle().get_blob(sha)?;}}
    }
    let id = unique_id("sandbox-"); let path = location(data,&id)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e|err("SANDBOX_IO",e.to_string()))?;
    bytes(&main,&["worktree","add","--detach",&path.to_string_lossy(),commit])?;
    let record = json!({"id":id,"base_commit":commit,"source_task":task_id,"source_seq":seq,"status":"open"});
    let saved = engineering::get(ws,"sandboxes")?;
    let mut records = saved["value"].as_array().cloned().unwrap_or_default(); records.push(record.clone());
    engineering::put(ws,"sandboxes",&json!(records),saved["revision"].as_str().unwrap_or("absent"),true)?;
    let (target,_) = open(ws,data,&id)?;
    if historical.is_some() {
        for (p,blob) in state {
            check_write_path(&p)?;
            let revision = target.hash(&p)?["revision"].as_str().unwrap_or("absent").to_owned();
            if let Some(sha)=blob.as_str() { target.write_bytes_protected(&p,&ws.checkpoint_handle().get_blob(sha)?,Some(&revision))?; }
            else if revision!="absent" { target.delete(&p)?; }
        }
    }
    Ok(record)
}
pub fn snapshot(ws: &Workspace) -> Result<Value, RuntimeError> {
    let root = root(ws)?;
    let mut paths = BTreeSet::new();
    for args in [&["diff","--name-only","-z","HEAD"][..], &["ls-files","--others","--exclude-standard","-z"][..]] {
        for p in bytes(&root,args)?.split(|x| *x==0).filter(|x| !x.is_empty()) { paths.insert(String::from_utf8(p.to_vec()).map_err(|_|err("BAD_PATH","文件名不是 UTF-8"))?); }
    }
    if paths.len()>200 { return Err(err("TOO_LARGE","单次应用最多 200 个文件，请拆分任务")); }
    if String::from_utf8_lossy(&bytes(&root,&["diff","--summary","HEAD"])?).contains("mode change") { return Err(err("WORKSPACE_CAPABILITY","执行权限变化需要手动审查")); }
    let mut files=Vec::new();
    for path in paths {
        check_read_path(&path)?; check_write_path(&path)?;
        let target=root.join(&path);
        for p in target.ancestors().take_while(|p| *p!=root) { if fs::symlink_metadata(p).is_ok_and(|m|m.file_type().is_symlink()) { return Err(err("WORKSPACE_CAPABILITY","不能自动应用符号链接")); } }
        let revision=ws.hash(&path)?["revision"].clone();
        let content=if revision=="absent" { Value::Null } else {
            let r=ws.read(&path)?;
            if r["binary"]==true { return Err(err("WORKSPACE_CAPABILITY","二进制变化请手动审查")); }
            r["content"].clone()
        };
        let before=git(&root,&["show",&format!("HEAD:{path}")],true)?;
        #[cfg(unix)]
        if before.is_none() {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&target).is_ok_and(|m| m.permissions().mode() & 0o111 != 0) {return Err(err("WORKSPACE_CAPABILITY","新增可执行文件需要手动审查"));}
        }
        let base_revision=before.as_ref().map(|b|format!("sha256:{}",sha256_hex(b))).unwrap_or_else(||"absent".into());
        files.push(json!({"path":path,"revision":revision,"base_revision":base_revision,"content":content,"before_content":before.as_ref().map(|b|String::from_utf8(b.clone())).transpose().map_err(|_|err("WORKSPACE_CAPABILITY","二进制变化请手动审查"))?}));
    }
    let keys:Vec<Value>=files.iter().map(|f|json!([f["path"],f["revision"]])).collect();
    let head=String::from_utf8_lossy(&bytes(&root,&["rev-parse","HEAD"])?).trim().to_owned();
    let revision=sha256_hex(serde_json::to_string(&json!([head,keys])).unwrap_or_default().as_bytes());
    Ok(json!({"files":files,"revision":revision}))
}
pub fn inspect(ws:&Workspace,data:&Path,id:&str)->Result<Value,RuntimeError>{
    let (child,mut record)=open(ws,data,id)?;
    let head=bytes(&root(&child)?,&["rev-parse","HEAD"])?;
    if String::from_utf8_lossy(&head).trim()!=record["base_commit"].as_str().unwrap_or(""){return Err(err("SANDBOX_BASE_CHANGED","沙箱 Git HEAD 已改变，请保留原基准并重新审查"));}
    let current=snapshot(&child)?;
    let tasks:Vec<Value>=child.checkpoint_tasks(50)?.iter().map(|t|child.checkpoint_task(t["id"].as_str().unwrap_or(""))).collect::<Result<_,_>>()?;
    let validated=tasks.iter().any(|t|t["events"].as_array().is_some_and(|es|es.iter().any(|e|e["type"]=="build_ok"&&e["workspace_revision"]==current["revision"])));
    record["files"]=current["files"].clone();record["revision"]=current["revision"].clone();record["tasks"]=json!(tasks);record["validated"]=json!(validated);Ok(record)
}
pub fn apply(ws:&Workspace,data:&Path,id:&str,revision:&str)->Result<Value,RuntimeError>{
    let current=inspect(ws,data,id)?;
    if current["status"]!="open" {return Err(err("BAD_SANDBOX","沙箱已经应用"));}
    if current["revision"]!=revision {return Err(err("CONFLICT","沙箱内容已变化，请重新审查"));}
    if current["validated"]!=true {return Err(err("VALIDATION_REQUIRED","当前沙箱版本还没有真实通过的验证"));}
    let files=current["files"].as_array().ok_or_else(||err("BAD_SANDBOX","文件列表无效"))?;
    for f in files {let p=f["path"].as_str().unwrap_or("");check_write_path(p)?;if ws.hash(p)?["revision"]!=f["base_revision"] {return Err(err("CONFLICT",format!("主工作区文件 {p} 与沙箱存在冲突")));}}
    let store=ws.checkpoint_handle();let task=store.start_task(&format!("应用沙箱 {id}"),"edit")?;let tid=task["id"].as_str().unwrap_or("");
    let mut changes=Vec::new();
    let operation=(||->Result<Vec<Value>,RuntimeError>{
        let mut applied=Vec::new();
        for f in files {
            let p=f["path"].as_str().unwrap_or("");let base=f["base_revision"].as_str().unwrap_or("absent");
            if ws.hash(p)?["revision"]!=base {return Err(err("CONFLICT","应用期间文件已变化"));}
            let before=if base=="absent" {None} else {Some(ws.read(p)?["content"].as_str().ok_or_else(||err("WORKSPACE_CAPABILITY","二进制文件无法自动应用"))?.as_bytes().to_vec())};
            store.record_before(tid,p,before.as_deref())?;
            let before_blob=before.as_ref().map(|b|store.put_blob(b)).transpose()?;
            let after=f["content"].as_str();
            let mutation=if let Some(text)=after {ws.write_text(p,text,Some(base))?}else{ws.delete(p)?};
            if mutation.changed {changes.push(mutation.event);}
            let after_blob=after.map(|t|store.put_blob(t.as_bytes())).transpose()?;
            store.add_event(tid,"edit",&format!("应用 {p}"),json!({"path":p,"before_blob":before_blob,"existed_before":before.is_some(),"after_blob":after_blob,"after_rev":ws.hash(p)?["revision"],"kind":if after.is_none(){"delete"}else if before.is_none(){"create"}else{"modify"}}))?;
            applied.push(json!(p));
        }
        Ok(applied)
    })();
    match operation {
        Ok(applied)=>{store.finish_task(tid,"done","应用完成")?;let saved=engineering::get(ws,"sandboxes")?;let mut records=saved["value"].clone();if let Some(xs)=records.as_array_mut(){for r in xs{if r["id"]==id{r["status"]=json!("applied");}}}engineering::put(ws,"sandboxes",&records,saved["revision"].as_str().unwrap_or("absent"),true)?;Ok(json!({"task_id":tid,"applied":applied,"events":changes}))},
        Err(e)=>{let _=store.finish_task(tid,"error","部分应用，可从检查点恢复");Err(e.with_data(json!({"task_id":tid,"events":changes})))},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { base:PathBuf, data:PathBuf, ws:Workspace }
    impl Fixture {
        fn new()->Self {
            let base=std::env::temp_dir().join(unique_id("koide-sandbox-"));
            let root=base.join("project");let data=base.join("data");
            fs::create_dir_all(&root).unwrap();fs::create_dir_all(&data).unwrap();
            bytes(&root,&["init"]).unwrap();fs::write(root.join("a.txt"),"before\n").unwrap();
            bytes(&root,&["add","."]).unwrap();
            bytes(&root,&["-c","user.name=Koide test","-c","user.email=test@example.invalid","commit","-m","baseline"]).unwrap();
            let ws=Workspace::open(&root.to_string_lossy(),&data).unwrap();Self{base,data,ws}
        }
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.base);}}
    #[test]
    fn refuses_dirty_source_and_unowned_paths(){
        let f=Fixture::new();fs::write(root(&f.ws).unwrap().join("a.txt"),"draft").unwrap();
        assert_eq!(create(&f.ws,&f.data,None,None).unwrap_err().code,"SANDBOX_DIRTY");
        assert!(open(&f.ws,&f.data,"../other").is_err());
    }
    #[test]
    fn apply_requires_matching_validation_and_main_revision(){
        let f=Fixture::new();let record=create(&f.ws,&f.data,None,None).unwrap();let id=record["id"].as_str().unwrap();
        let (child,_)=open(&f.ws,&f.data,id).unwrap();let rev=child.hash("a.txt").unwrap()["revision"].as_str().unwrap().to_owned();
        child.write_text("a.txt","after\n",Some(&rev)).unwrap();
        let current=snapshot(&child).unwrap();let revision=current["revision"].as_str().unwrap();
        assert_eq!(apply(&f.ws,&f.data,id,revision).unwrap_err().code,"VALIDATION_REQUIRED");
        let store=child.checkpoint_handle();let task=store.start_task("验证","agent").unwrap();
        store.add_event(task["id"].as_str().unwrap(),"build_ok","验证通过",json!({"workspace_revision":revision})).unwrap();
        assert_eq!(inspect(&f.ws,&f.data,id).unwrap()["validated"],true);
        fs::write(root(&f.ws).unwrap().join("a.txt"),"external").unwrap();
        assert_eq!(apply(&f.ws,&f.data,id,revision).unwrap_err().code,"CONFLICT");
        let rev=child.hash("a.txt").unwrap()["revision"].as_str().unwrap().to_owned();
        child.write_text("a.txt","changed again",Some(&rev)).unwrap();
        assert_eq!(inspect(&f.ws,&f.data,id).unwrap()["validated"],false);
    }
}
