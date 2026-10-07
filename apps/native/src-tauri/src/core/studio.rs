//! 项目工作台的数据、启动检查和可恢复的隔离试验。
use super::{checkpoint::CheckpointStore, crypto::sha256_hex, id::unique_id, policy, workspace::Workspace, RuntimeError};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const STATE: &str = ".koide/studio.json";
const MAX_FILES: usize = 5000;
const MAX_TOTAL: usize = 128 * 1024 * 1024;
#[derive(Clone)]
struct Entry { revision: String, bytes: Vec<u8> }
fn err(code: &str, message: &str) -> RuntimeError { RuntimeError::new(code, message) }
fn now() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() }
fn safe_part(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    !matches!(n.as_str(), ".koide"|".git"|".diffusion"|"node_modules"|"vendor"|"target"|"dist"|"build"|".gradle"|".idea"|"__pycache__"|".venv"|"venv"|".next"|".nuxt"|"coverage")
        && !n.starts_with(".diffusion-tmp-") && !n.starts_with(".koide-tmp-") && policy::check_read_path(name).is_ok()
}
fn local_root(ws: &Workspace) -> Result<PathBuf, RuntimeError> { ws.local_root_path().ok_or_else(|| err("WORKSPACE_CAPABILITY", "项目快照和隔离试验需要本地文件系统，SAF 项目请使用工作台数据和人工验收")) }
fn read_bytes(ws: &Workspace, raw: &str) -> Result<Vec<u8>, RuntimeError> {
    policy::check_read_path(raw)?;
    // Workspace performs canonical sandbox validation before any binary read.
    ws.hash(raw)?;
    let root = local_root(ws)?;
    let path = root.join(raw);
    let meta = fs::symlink_metadata(&path).map_err(|_| err("NOT_FOUND", "项目文件不存在"))?;
    if meta.file_type().is_symlink() || !meta.is_file() { return Err(err("STUDIO_UNSUPPORTED_ENTRY", "快照不包含符号链接或特殊文件")); }
    let real = fs::canonicalize(&path).map_err(|_| err("READ_FAILED", "无法解析项目文件"))?;
    if !real.starts_with(&root) { return Err(err("OUTSIDE_WORKSPACE", "项目文件指向了工作区之外")); }
    fs::read(real).map_err(|_| err("READ_FAILED", "无法读取项目文件"))
}
fn scan(ws: &Workspace, directory: &str) -> Result<BTreeMap<String, Entry>, RuntimeError> {
    let root = local_root(ws)?;
    let folder = root.join(directory);
    let real = fs::canonicalize(&folder).map_err(|_| err("NOT_FOUND", "快照目录不存在"))?;
    if !real.starts_with(&root) || fs::symlink_metadata(&folder).map(|m|m.file_type().is_symlink()).unwrap_or(true) { return Err(err("OUTSIDE_WORKSPACE", "快照目录必须是工作区内部的普通文件夹")); }
    let mut stack = vec![(directory.to_owned(), String::new())];
    let mut files = BTreeMap::new(); let mut total = 0usize;
    while let Some((current, prefix)) = stack.pop() {
        let tree = ws.tree(&current, 1, true)?;
        for node in tree.as_array().into_iter().flatten() {
            let name = node["name"].as_str().unwrap_or("");
            if !safe_part(name) { continue; }
            let relative = if prefix.is_empty() {name.to_owned()} else {format!("{prefix}/{name}")};
            let raw = if directory == "." { relative.clone() } else { format!("{directory}/{relative}") };
            if policy::check_read_path(&raw).is_err() { continue; }
            let candidate = root.join(&raw);
            if fs::symlink_metadata(&candidate).map(|m|m.file_type().is_symlink()).unwrap_or(true) { continue; }
            if node["type"].as_str() == Some("dir") { stack.push((raw, relative)); continue; }
            total = total.saturating_add(node["size"].as_u64().unwrap_or(0) as usize);
            if files.len() >= MAX_FILES || total > MAX_TOTAL { return Err(err("TOO_LARGE", "工作台快照最多支持 5000 个文件、128 MiB，请排除生成物或拆分项目")); }
            let bytes = read_bytes(ws, &raw)?;
            files.insert(relative, Entry {revision: format!("sha256:{}", sha256_hex(&bytes)), bytes});
        }
    }
    Ok(files)
}
fn fingerprint_with(
    tree: impl Fn(&str) -> Result<Value, RuntimeError>,
    hash: impl Fn(&str) -> Result<Value, RuntimeError>,
    symlink: impl Fn(&str) -> Result<bool, RuntimeError>,
) -> Result<Value, RuntimeError> {
    let mut stack=vec![".".to_owned()];let mut files=BTreeMap::new();let mut total=0u64;let mut directories=0usize;
    while let Some(directory)=stack.pop(){
        directories+=1;if directories>MAX_FILES*2||directory.matches('/').count()>256{return Err(err("TOO_LARGE","项目目录过多或层级过深，无法建立验收指纹"));}
        let nodes=tree(&directory)?;
        for node in nodes.as_array().into_iter().flatten(){
            let name=node["name"].as_str().ok_or_else(||err("STUDIO_INVALID_DATA","工作区目录缺少文件名"))?;
            if name.is_empty()||matches!(name,"."|"..")||name.contains(['/', '\\']){return Err(err("STUDIO_INVALID_DATA","工作区目录提供了无效的文件名"));}
            if !safe_part(name){continue;}
            let path=if directory=="."{name.to_owned()}else{format!("{directory}/{name}")};
            if policy::check_read_path(&path).is_err()||symlink(&path)?{continue;}
            match node["type"].as_str(){
                Some("dir")=>stack.push(path),
                Some("file")=>{
                    total=total.saturating_add(node["size"].as_u64().unwrap_or(0));
                    if files.len()>=MAX_FILES||total>MAX_TOTAL as u64{return Err(err("TOO_LARGE","项目验收指纹最多支持 5000 个文件、128 MiB，请排除生成物或拆分项目"));}
                    let value=hash(&path)?;let revision=value["revision"].as_str().filter(|r|r.starts_with("sha256:")).ok_or_else(||err("CONFLICT","项目文件在验收指纹计算期间改变，请重试"))?;
                    files.insert(path,revision.to_owned());
                },
                _=>return Err(err("STUDIO_INVALID_DATA","工作区目录提供了未知文件类型")),
            }
        }
    }
    let mut bytes = Vec::new();
    for (path, revision) in &files { bytes.extend_from_slice(path.as_bytes()); bytes.push(0); bytes.extend_from_slice(revision.as_bytes()); bytes.push(b'\n'); }
    Ok(json!({"revision":format!("sha256:{}",sha256_hex(&bytes)),"files_count":files.len()}))
}
pub fn revision(ws: &Workspace) -> Result<Value, RuntimeError> {
    let local=ws.local_root_path();
    fingerprint_with(|path|ws.tree(path,1,true),|path|ws.hash(path),|path|{
        match &local {Some(root)=>fs::symlink_metadata(root.join(path)).map(|m|m.file_type().is_symlink()).map_err(|_|err("CONFLICT","项目文件在验收指纹计算期间改变，请重试")),None=>Ok(false)}
    })
}
fn read_json(ws: &Workspace, path: &str) -> Result<(Value,String),RuntimeError> {
    let file = ws.read(path)?;
    let data: Value = serde_json::from_str(file["content"].as_str().unwrap_or("")).map_err(|_| err("STUDIO_INVALID_DATA", "工作台文件不是有效 JSON，请先恢复或修复"))?;
    if !data.is_object() { return Err(err("STUDIO_INVALID_DATA", "工作台数据必须是 JSON 对象")); }
    Ok((data,file["revision"].as_str().unwrap_or("absent").to_owned()))
}
pub fn read(ws: &Workspace) -> Result<Value,RuntimeError> {
    match read_json(ws,STATE) {
        Ok((data,revision))=>Ok(json!({"data":data,"revision":revision,"path":STATE,"workspace_key":ws.storage_key()})),
        Err(e) if e.code=="NOT_FOUND"=>Ok(json!({"data":{},"revision":"absent","path":STATE,"workspace_key":ws.storage_key()})),
        Err(e)=>Err(e),
    }
}
fn record(store: &CheckpointStore, id: &str, event: &Value, before: Option<&[u8]>) -> Result<(), RuntimeError> {
    let path = event["path"].as_str().unwrap_or("");
    let blob = store.blob_for_event_before(before)?;
    store.add_event(id,"edit",&format!("工作台修改 {path}"),json!({"path":path,"kind":event["kind"],"before_blob":blob,"existed_before":before.is_some(),"after_rev":event["after_rev"]}))?;
    Ok(())
}
pub fn write(ws: &Workspace, data: &Value, base: Option<&str>) -> Result<(Value, Vec<Value>),RuntimeError> {
    if !data.is_object() {return Err(err("BAD_PARAMS","工作台数据必须是 JSON 对象"));}
    let base = base.filter(|b|!b.is_empty()).ok_or_else(||err("NEEDS_REVISION","保存工作台需要基础版本，请先读取"))?;
    let mut text = serde_json::to_string_pretty(data).map_err(|_|err("BAD_PARAMS","工作台数据无法序列化"))?; text.push('\n');
    if text.len()>2*1024*1024 {return Err(err("TOO_LARGE","工作台数据超过 2 MiB，图片应使用附件文件"));}
    let old = read(ws)?;
    if old["revision"].as_str()!=Some(base) { return Err(err("CONFLICT","项目工作台已经被修改，请刷新后重试").with_data(json!({"current_revision":old["revision"]}))); }
    let before = if base=="absent" {None} else {Some(ws.read(STATE)?["content"].as_str().unwrap_or("").as_bytes().to_vec())};
    let store=ws.checkpoint_handle(); let task=store.start_task("保存项目工作台","studio")?; let id=task["id"].as_str().unwrap_or("");
    store.record_before(id,STATE,before.as_deref())?;
    let result = ws.write_text(STATE,&text,Some(base));
    match result {
        Ok(m)=>{if m.changed {record(&store,id,&m.event,before.as_deref())?;}store.finish_task(id,"done","项目工作台已保存")?;Ok((json!({"data":data,"revision":m.result["revision"],"task_id":id,"workspace_key":ws.storage_key()}),if m.changed {vec![m.event]} else {vec![]}))},
        Err(e)=>{let _=store.finish_task(id,"error","保存失败，原有数据保持可恢复");Err(e)},
    }
}
fn tool_available(tool:&str)->bool {
    let path=std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).any(|dir|{ if cfg!(windows) { [".exe",".cmd",".bat",".ps1"].iter().any(|ext|dir.join(format!("{tool}{ext}")).is_file()) } else {dir.join(tool).is_file()} })
}
pub fn inspect_launch(ws:&Workspace)->Result<Value,RuntimeError>{
    let files=scan(ws,".")?; let root=local_root(ws)?;
    let mut commands=Vec::new(); let mut manifests=Vec::new(); let mut notices=Vec::new(); let mut kinds=std::collections::BTreeSet::new();
    for (path,entry) in &files {
        if path.matches('/').count()>3 {continue;}
        let p=Path::new(path); let name=p.file_name().and_then(|n|n.to_str()).unwrap_or(""); let cwd=p.parent().filter(|p|!p.as_os_str().is_empty()).map(|p|p.to_string_lossy().replace('\\',"/")).unwrap_or(".".into());
        let kind=match name {"package.json"=>"node","Cargo.toml"=>"rust","pyproject.toml"|"requirements.txt"|"manage.py"=>"python",_=>continue};
        kinds.insert(kind); manifests.push(json!({"path":path,"kind":kind,"revision":entry.revision}));
        if name=="package.json" {
            let package=match serde_json::from_slice::<Value>(&entry.bytes){Ok(x) if x.is_object()=>x,_=>{notices.push(format!("{path} 的 JSON 无效"));continue;}};
            for (script,body) in package["scripts"].as_object().into_iter().flatten(){
                if !body.is_string() || script.len()>120 || !script.chars().all(|c|c.is_ascii_alphanumeric()||"_-:.".contains(c)){continue;}
                let purpose=if ["dev","start","serve","preview"].contains(&script.as_str()){"run"}else if ["test","lint","check","typecheck","build"].contains(&script.as_str()){"verify"}else{"script"};
                commands.push(json!({"id":format!("{path}:{script}"),"name":format!("{cwd} · {script}"),"label":format!("{cwd} · {script}"),"command":format!("pnpm run {script}"),"cwd":cwd,"kind":purpose,"source":path,"script":body,"needs_install":!root.join(&cwd).join("node_modules").is_dir()}));
            }
        }else {
            let list=match name {"Cargo.toml"=>vec![("cargo run","run"),("cargo test","verify"),("cargo check","verify")],"manage.py"=>vec![("python manage.py runserver","run")],"pyproject.toml"=>vec![("python -m unittest discover -v","verify")],_=>vec![]};
            for (command,purpose) in list {commands.push(json!({"id":format!("{path}:{command}"),"name":format!("{cwd} · {command}"),"command":command,"cwd":cwd,"kind":purpose,"source":path}));}
        }
    }
    let environment=["pnpm","node","cargo","python","git"].into_iter().map(|name|{let available=tool_available(name);json!({"name":name,"available":available,"detail":if available{"已安装"}else{"未在 PATH 中找到"}})}).collect::<Vec<_>>();
    Ok(json!({"commands":commands,"candidates":commands,"environment":environment,"manifests":manifests,"project_type":kinds.into_iter().collect::<Vec<_>>().join(" / "),"notices":notices,"auto_install":false,"capabilities":{"launch":true,"preview":true}}))
}
fn validate_id(id:&str)->Result<(),RuntimeError>{if id.is_empty()||id.len()>96||!id.bytes().all(|b|b.is_ascii_hexdigit()){Err(err("BAD_EXPERIMENT","试验编号无效"))}else{Ok(())}}
fn prefix(id:&str)->Result<String,RuntimeError>{validate_id(id)?;Ok(format!(".koide/experiments/{id}"))}
fn revisions(files:&BTreeMap<String,Entry>)->Value{Value::Object(files.iter().map(|(p,e)|(p.clone(),json!(e.revision))).collect())}
fn baseline_revision(baseline:&Value)->String{format!("sha256:{}",sha256_hex(serde_json::to_string(baseline).unwrap().as_bytes()))}
pub fn experiments_list(ws:&Workspace)->Result<Value,RuntimeError>{
    if ws.is_saf(){return Err(err("WORKSPACE_CAPABILITY","隔离试验需要本地文件系统"));}
    let tree=match ws.tree(".koide/experiments",1,true){Ok(t)=>t,Err(e) if e.code=="NOT_FOUND"=>json!([]),Err(e)=>return Err(e)};
    let mut items=Vec::new();
    for node in tree.as_array().into_iter().flatten(){let id=node["name"].as_str().unwrap_or("");if validate_id(id).is_err(){continue;}if let Ok(mut data)=verified_manifest(ws,id){data.as_object_mut().map(|o|o.remove("baseline"));items.push(data);}}
    items.sort_by(|a,b|b["created_at"].as_f64().unwrap_or(0.0).partial_cmp(&a["created_at"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    Ok(json!({"items":items,"experiments":items,"capabilities":{"isolated":true,"apply":true}}))
}
pub fn experiments_create(ws:&Workspace,name:&str)->Result<(Value,Vec<Value>),RuntimeError>{experiments_create_from(ws,name,None)}
pub fn experiments_create_from(ws:&Workspace,name:&str,baseline_id:Option<&str>)->Result<(Value,Vec<Value>),RuntimeError>{
    if name.trim().is_empty()||name.chars().count()>120{return Err(err("BAD_PARAMS","试验名称须为 1 到 120 个字符"));}
    let files=if let Some(id)=baseline_id{let (manifest,base,_)=experiment(ws,id)?;if manifest["baseline"]!=revisions(&base){return Err(err("CONFLICT","试验原始基线已经被修改"));}base}else{scan(ws,".")?};
    let id=unique_id("");let pre=prefix(&id)?;let store=ws.checkpoint_handle();let task=store.start_task(&format!("创建试验：{}",name.trim()),"studio")?;let tid=task["id"].as_str().unwrap_or("");let mut events=Vec::new();
    let result=(||{
        events.push(ws.create(&format!("{pre}/work"),"dir","")?.event);events.push(ws.create(&format!("{pre}/base"),"dir","")?.event);
        for (path,entry) in &files {for folder in ["work","base"]{let target=format!("{pre}/{folder}/{path}");store.record_before(tid,&target,None)?;let m=ws.write_bytes_protected(&target,&entry.bytes,Some("absent"))?;record(&store,tid,&m.event,None)?;events.push(m.event);}}
        let baseline=revisions(&files);let manifest=json!({"id":id,"name":name.trim(),"created_at":now(),"workspace_path":format!("{pre}/work"),"baseline_revision":baseline_revision(&baseline),"baseline":baseline,"files_count":files.len(),"status":"ready","baseline_id":baseline_id,"creation_task_id":tid});let target=format!("{pre}/manifest.json");store.record_before(tid,&target,None)?;let m=ws.write_text(&target,&serde_json::to_string_pretty(&manifest).unwrap(),Some("absent"))?;record(&store,tid,&m.event,None)?;events.push(m.event);
        let mut response=manifest;response.as_object_mut().unwrap().remove("baseline");response["task_id"]=json!(tid);response["absolute_path"]=json!(local_root(ws)?.join(format!("{pre}/work")).to_string_lossy());Ok(response)
    })();
    store.finish_task(tid,if result.is_ok(){"done"}else{"error"},if result.is_ok(){"隔离试验已建立，依赖需单独安装"}else{"创建中止，可通过检查点恢复"})?;
    result.map(|v|(v,events))
}
fn verified_manifest(ws:&Workspace,id:&str)->Result<Value,RuntimeError>{
    let path=format!("{}/manifest.json",prefix(id)?);let (mut manifest,rev)=read_json(ws,&path)?;
    let task=ws.checkpoint_handle().load(manifest["creation_task_id"].as_str().unwrap_or("")).map_err(|_|err("STUDIO_INVALID_DATA","试验缺少可信创建记录，请重新创建"))?;
    if manifest["id"]!=id||!task["events"].as_array().into_iter().flatten().any(|event|event["type"]=="edit"&&event["path"]==path&&event["after_rev"]==rev){return Err(err("CONFLICT","试验清单已被修改，不能信任其基线，请重新创建"));}
    manifest["workspace_path"]=json!(format!("{}/work",prefix(id)?));manifest["absolute_path"]=json!(local_root(ws)?.join(format!("{}/work",prefix(id)?)).to_string_lossy());manifest["baseline_revision"]=json!(baseline_revision(&manifest["baseline"]));Ok(manifest)
}
fn experiment(ws:&Workspace,id:&str)->Result<(Value,BTreeMap<String,Entry>,BTreeMap<String,Entry>),RuntimeError>{
    let pre=prefix(id)?;let manifest=verified_manifest(ws,id)?;let base=scan(ws,&format!("{pre}/base"))?;
    if manifest["baseline"]!=revisions(&base){return Err(err("CONFLICT","试验原始基线已经被修改，无法安全比较或应用"));}
    let work=scan(ws,&format!("{pre}/work"))?;Ok((manifest,base,work))
}
fn change_list(base:&BTreeMap<String,Entry>,work:&BTreeMap<String,Entry>,current:&BTreeMap<String,Entry>)->Vec<Value>{
    let keys=base.keys().chain(work.keys()).collect::<std::collections::BTreeSet<_>>();let mut changes=Vec::new();let mut text_budget=2*1024*1024usize;
    for path in keys{let before=base.get(path);let after=work.get(path);let br=before.map(|e|e.revision.as_str()).unwrap_or("absent");let ar=after.map(|e|e.revision.as_str()).unwrap_or("absent");if br==ar{continue;}let cr=current.get(path).map(|e|e.revision.as_str()).unwrap_or("absent");let kind=if before.is_none(){"create"}else if after.is_none(){"delete"}else{"modify"};
        let text=|entry:Option<&Entry>,limit:usize|entry.and_then(|e|std::str::from_utf8(&e.bytes).ok()).filter(|t|!t.contains('\0')).map(|t|t.chars().take(limit).collect::<String>());
        let bt=text(before,text_budget.min(400000)/4);text_budget=text_budget.saturating_sub(bt.as_ref().map(|s|s.len()).unwrap_or(0));let at=text(after,text_budget.min(400000)/4);text_budget=text_budget.saturating_sub(at.as_ref().map(|s|s.len()).unwrap_or(0));let binary=(before.is_some()&&bt.is_none())||(after.is_some()&&at.is_none());let truncated=!binary&&(before.map(|e|e.bytes.len()>bt.as_ref().map(|s|s.len()).unwrap_or(0)).unwrap_or(false)||after.map(|e|e.bytes.len()>at.as_ref().map(|s|s.len()).unwrap_or(0)).unwrap_or(false));changes.push(json!({"path":path,"kind":kind,"status":kind,"before_revision":br,"after_revision":ar,"current_revision":cr,"conflict":cr!=br,"binary":binary,"content_truncated":truncated,"before":bt.unwrap_or_default(),"after":at.unwrap_or_default()}));
    }changes
}
pub fn experiments_diff(ws:&Workspace,id:&str)->Result<Value,RuntimeError>{let (manifest,base,work)=experiment(ws,id)?;let current=scan(ws,".")?;let changes=change_list(&base,&work,&current);Ok(json!({"id":id,"name":manifest["name"],"files":changes,"changes":changes,"has_conflicts":changes.iter().any(|c|c["conflict"]==true),"baseline_verified":true}))}
pub fn experiments_apply(ws:&Workspace,id:&str)->Result<(Value,Vec<Value>),RuntimeError>{
    let (manifest,base,work)=experiment(ws,id)?;let current=scan(ws,".")?;let changes=change_list(&base,&work,&current);
    if changes.iter().any(|c|c["conflict"]==true){return Err(err("CONFLICT","主项目已偏离试验基线，请保留两边修改后重新试验").with_data(json!({"conflicts":changes.iter().filter(|c|c["conflict"]==true).map(|c|c["path"].clone()).collect::<Vec<_>>()})));}
    for change in &changes{policy::check_write_path(change["path"].as_str().unwrap_or(""))?;}
    let store=ws.checkpoint_handle();let task=store.start_task(&format!("应用试验：{}",manifest["name"].as_str().unwrap_or("试验")),"studio")?;let tid=task["id"].as_str().unwrap_or("");let mut events=Vec::new();
    let result=(||{for change in &changes{
        let path=change["path"].as_str().unwrap_or("");let expected=change["before_revision"].as_str().unwrap_or("absent");if ws.hash(path)?["revision"]!=expected{return Err(err("CONFLICT","文件在应用期间发生改变，操作中止"));}
        let before=current.get(path).map(|e|e.bytes.as_slice());store.record_before(tid,path,before)?;
        let m=if change["kind"]=="delete"{ws.delete_if_revision(path,expected)?}else{ws.write_bytes_protected(path,&work[path].bytes,Some(expected))?};record(&store,tid,&m.event,before)?;events.push(m.event);
    }Ok(json!({"id":id,"applied":changes.len(),"task_id":tid,"changes":changes}))})();
    store.finish_task(tid,if result.is_ok(){"done"}else{"error"},if result.is_ok(){"试验已应用"}else{"应用中止，已应用部分可通过检查点恢复"})?;result.map(|v|(v,events))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->(Workspace,PathBuf){let tmp=std::env::temp_dir().join(unique_id("koide-studio-test-"));fs::create_dir_all(tmp.join("project")).unwrap();fs::create_dir_all(tmp.join("data")).unwrap();let ws=Workspace::open(tmp.join("project").to_str().unwrap(),&tmp.join("data")).unwrap();(ws,tmp)}
    #[test]fn state_needs_revision_and_checkpoints(){let(ws,tmp)=fixture();assert_eq!(read(&ws).unwrap()["revision"],"absent");assert!(write(&ws,&json!({"room":"rain"}),None).is_err());let(v,_)=write(&ws,&json!({"room":"rain"}),Some("absent")).unwrap();assert_eq!(read(&ws).unwrap()["data"]["room"],"rain");assert!(write(&ws,&json!({}),Some("absent")).is_err());ws.checkpoint_revert_task(v["task_id"].as_str().unwrap()).unwrap();assert_eq!(read(&ws).unwrap()["revision"],"absent");fs::remove_dir_all(tmp).unwrap();}
    #[test]fn experiment_apply_detects_conflicts_and_restores(){let(ws,tmp)=fixture();ws.write_text("a.js","one",None).unwrap();let(e,_)=experiments_create(&ws,"方案 A").unwrap();let id=e["id"].as_str().unwrap();ws.write_text(&format!("{}/a.js",e["workspace_path"].as_str().unwrap()),"two",None).unwrap();ws.write_text("a.js","external",None).unwrap();assert_eq!(experiments_apply(&ws,id).unwrap_err().code,"CONFLICT");ws.write_text("a.js","one",None).unwrap();let(applied,_)=experiments_apply(&ws,id).unwrap();assert_eq!(ws.read("a.js").unwrap()["content"],"two");ws.checkpoint_revert_task(applied["task_id"].as_str().unwrap()).unwrap();assert_eq!(ws.read("a.js").unwrap()["content"],"one");fs::remove_dir_all(tmp).unwrap();}
    #[test]fn revision_ignores_generated_and_metadata(){let(ws,tmp)=fixture();ws.write_text("a.js","one",None).unwrap();let original=revision(&ws).unwrap();ws.write_text("node_modules/dep.js","generated",None).unwrap();write(&ws,&json!({"scene":"deep"}),Some("absent")).unwrap();assert_eq!(revision(&ws).unwrap(),original);ws.write_text("a.js","two",None).unwrap();assert_ne!(revision(&ws).unwrap(),original);fs::remove_dir_all(tmp).unwrap();}
    #[test]fn manifest_cannot_forge_private_creation_evidence(){let(ws,tmp)=fixture();ws.write_text("a.js","one",None).unwrap();let(e,_)=experiments_create(&ws,"方案 A").unwrap();let id=e["id"].as_str().unwrap();let path=format!("{}/manifest.json",prefix(id).unwrap());let(mut manifest,_)=read_json(&ws,&path).unwrap();manifest["baseline"]["a.js"]=json!("sha256:forged");ws.write_text(&path,&manifest.to_string(),None).unwrap();assert_eq!(experiments_diff(&ws,id).unwrap_err().code,"CONFLICT");fs::remove_dir_all(tmp).unwrap();}
    #[test]fn fingerprint_uses_relative_workspace_calls_without_a_local_path(){let trees=BTreeMap::from([(".".to_owned(),json!([{"name":"src","type":"dir","size":0},{"name":".koide","type":"dir","size":0},{"name":".env","type":"file","size":100}])),("src".to_owned(),json!([{"name":"a.js","type":"file","size":3}]))]);let fingerprints=|revision:&str|fingerprint_with(|path|trees.get(path).cloned().ok_or_else(||err("NOT_FOUND","模拟目录不存在")),|path|{assert_eq!(path,"src/a.js");Ok(json!({"revision":revision}))},|_|Ok(false)).unwrap();let first=fingerprints("sha256:aaa");let second=fingerprints("sha256:bbb");assert_eq!(first["files_count"],1);assert_ne!(first["revision"],second["revision"]);}
    #[test]fn fingerprint_rejects_provider_escape_and_oversized_tree(){assert_eq!(fingerprint_with(|_|Ok(json!([{"name":"../escape","type":"file","size":1}])),|_|unreachable!(),|_|Ok(false)).unwrap_err().code,"STUDIO_INVALID_DATA");assert_eq!(fingerprint_with(|_|Ok(json!([{"name":"large.bin","type":"file","size":MAX_TOTAL+1}])),|_|unreachable!(),|_|Ok(false)).unwrap_err().code,"TOO_LARGE");}
}
