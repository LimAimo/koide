//! 单独端口上的受控开发页代理，不提供任何 IDE RPC 或文件权限。
use super::RuntimeError;
use base64::Engine;
use reqwest::Url;
use serde_json::{json,Value};
use std::{collections::{HashMap,HashSet},fs,io::{Read,Write},net::{TcpListener,TcpStream},path::PathBuf,process::{Command,Stdio},sync::{Arc,atomic::{AtomicBool,AtomicUsize,Ordering}},thread,time::{Duration,Instant}};

const MAX_BODY:usize=16*1024*1024;
const CSP:&str="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
fn error(code:&str,message:&str)->RuntimeError{RuntimeError::new(code,message)}
fn source(url:&str,blocked:&HashSet<u16>)->Result<Url,RuntimeError>{
    if url.len()>4096||url.chars().any(|c|c.is_control()){return Err(error("PREVIEW_URL","预览地址无效"));}
    let mut parsed=Url::parse(url).map_err(|_|error("PREVIEW_URL","预览地址无效"))?;
    if parsed.scheme()!="http"||!parsed.username().is_empty()||parsed.password().is_some()||!matches!(parsed.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"|"::1")){return Err(error("PREVIEW_URL","预览只接受本机开发服务器的 HTTP 地址"));}
    let port=parsed.port_or_known_default().unwrap_or(80);
    if port<1024||[2375,2376,5432,6379,8765,9222,9223,27017].contains(&port)||blocked.contains(&port){return Err(error("PREVIEW_PORT","此端口属于运行时或管理服务，不能用作项目预览"));}
    if parsed.host_str()==Some("localhost"){parsed.set_host(Some("127.0.0.1")).map_err(|_|error("PREVIEW_URL","预览地址无效"))?;}
    parsed.set_fragment(None);Ok(parsed)
}
struct Session{stop:Arc<AtomicBool>,url:String,port:u16}
pub struct PreviewManager{sessions:HashMap<String,Session>,data_dir:PathBuf}
impl PreviewManager{
    pub fn new(data_dir:PathBuf)->Self{Self{sessions:HashMap::new(),data_dir:data_dir.join("preview")}}
    pub fn open(&mut self,url:&str)->Result<Value,RuntimeError>{
        if self.sessions.len()>=4{return Err(error("PREVIEW_LIMIT","最多同时打开 4 个预览，请先关闭不需要的预览"));}
        let blocked=self.sessions.values().map(|s|s.port).collect::<HashSet<_>>();let target=source(url,&blocked)?;
        let mut bytes=[0u8;32];getrandom::getrandom(&mut bytes).map_err(|_|error("PREVIEW_INIT","系统随机数不可用"))?;let token=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        let listener=TcpListener::bind("127.0.0.1:0").map_err(|_|error("PREVIEW_INIT","无法建立独立预览服务"))?;listener.set_nonblocking(true).map_err(|_|error("PREVIEW_INIT","无法设置预览服务"))?;
        let port=listener.local_addr().map_err(|_|error("PREVIEW_INIT","预览端口不可用"))?.port();let stop=Arc::new(AtomicBool::new(false));let stop_worker=stop.clone();let key=token.clone();let base=target.clone();
        let workers=Arc::new(AtomicUsize::new(0));
        thread::spawn(move||{while !stop_worker.load(Ordering::Relaxed){match listener.accept(){Ok((stream,_))=>{if workers.fetch_add(1,Ordering::Relaxed)>=8{workers.fetch_sub(1,Ordering::Relaxed);continue;}let key=key.clone();let base=base.clone();let workers=workers.clone();let stopped=stop_worker.clone();thread::spawn(move||{handle(stream,&key,&base,&stopped);workers.fetch_sub(1,Ordering::Relaxed);});},Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(25)),Err(_)=>break}}});
        let query=target.query().map(|q|format!("?{q}")).unwrap_or_default();let proxy_url=format!("http://127.0.0.1:{port}/{token}{}{query}",target.path());
        self.sessions.insert(token.clone(),Session{stop,url:proxy_url.clone(),port});
        Ok(json!({"id":token,"token":token,"url":proxy_url,"source_url":url,"capabilities":{"inspect":true,"console":true,"screenshot":browser().is_some(),"websocket":false,"forms":false,"read_only":true},"notice":"只读预览支持元素检查、控制台和截图；提交表单与 WebSocket 暂不可用，修改后请刷新。"}))
    }
    pub fn close(&mut self,id:&str)->Result<Value,RuntimeError>{let session=self.sessions.remove(id);if let Some(s)=&session{s.stop.store(true,Ordering::Relaxed);}Ok(json!({"closed":session.is_some()}))}
    pub fn close_all(&mut self){for session in self.sessions.drain().map(|(_,s)|s){session.stop.store(true,Ordering::Relaxed);}}
    pub fn capture(&self,id:&str,width:u64,height:u64)->Result<Value,RuntimeError>{
        let session=self.sessions.get(id).ok_or_else(||error("PREVIEW_NOT_FOUND","预览已关闭，请重新打开"))?;
        let executable=browser().ok_or_else(||error("SCREENSHOT_UNAVAILABLE","未找到 Chrome 或 Edge，可安装浏览器或添加手动截图附件"))?;
        if !(320..=2560).contains(&width)||!(240..=2560).contains(&height){return Err(error("BAD_PARAMS","截图尺寸须在 320×240 与 2560×2560 之间"));}
        let directory=self.data_dir.join(super::id::unique_id("capture-"));fs::create_dir_all(&directory).map_err(|_|error("SCREENSHOT_UNAVAILABLE","无法建立截图临时目录"))?;
        let output=directory.join("screenshot.png");let result=(||{
            // 仅此会话直连；其余 HTTP/HTTPS 导航送入拒绝 CONNECT/绝对地址的只读代理。
            let mut command=Command::new(executable);command.args(["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--hide-scrollbars","--disable-extensions","--disable-background-networking","--virtual-time-budget=1500"])
                .arg(format!("--proxy-server=http://127.0.0.1:{}",session.port)).arg(format!("--proxy-bypass-list=<-loopback>;http://127.0.0.1:{}",session.port))
                .arg(format!("--user-data-dir={}",directory.join("profile").display())).arg(format!("--window-size={width},{height}")).arg(format!("--screenshot={}",output.display())).arg(&session.url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
            let mut child=command.spawn().map_err(|_|error("SCREENSHOT_UNAVAILABLE","无法启动浏览器截图"))?;let start=Instant::now();
            let status=loop{if let Some(status)=child.try_wait().map_err(|_|error("SCREENSHOT_UNAVAILABLE","无法读取截图进程"))?{break status;}if start.elapsed()>Duration::from_secs(15){let _=child.kill();let _=child.wait();return Err(error("SCREENSHOT_UNAVAILABLE","浏览器截图未完成，可重试或添加手动截图附件"));}thread::sleep(Duration::from_millis(50));};
            let bytes=fs::read(&output).map_err(|_|error("SCREENSHOT_UNAVAILABLE","浏览器没有生成截图"))?;
            if !status.success()||!bytes.starts_with(b"\x89PNG\r\n\x1a\n")||bytes.len()>MAX_BODY{return Err(error("SCREENSHOT_UNAVAILABLE","浏览器没有生成有效截图"));}
            let image=format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes));Ok(json!({"id":id,"image":image,"data_url":image,"width":width,"height":height,"captured_at":SystemTimeCompat::now(),"source":"browser"}))
        })();let _=fs::remove_dir_all(directory);result
    }
}
impl Drop for PreviewManager{fn drop(&mut self){self.close_all();}}
struct SystemTimeCompat;
impl SystemTimeCompat{fn now()->f64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs_f64()}}
fn browser()->Option<PathBuf>{
    let mut candidates=Vec::new();
    if cfg!(windows){for variable in ["PROGRAMFILES","PROGRAMFILES(X86)","LOCALAPPDATA"]{if let Some(root)=std::env::var_os(variable){for relative in ["Microsoft/Edge/Application/msedge.exe","Google/Chrome/Application/chrome.exe"]{candidates.push(PathBuf::from(&root).join(relative));}}}}
    else{for path in ["/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/google-chrome","/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]{candidates.push(PathBuf::from(path));}}
    candidates.into_iter().find(|p|p.is_file())
}
fn respond(stream:&mut TcpStream,status:u16,headers:&[(&str,String)],body:&[u8],head:bool){
    let reason=match status{200=>"OK",403=>"Forbidden",405=>"Method Not Allowed",502=>"Bad Gateway",_=>"Response"};let mut text=format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: {}\r\n",body.len());
    for (key,value) in headers{if !value.contains(['\r','\n']){text.push_str(&format!("{key}: {value}\r\n"));}}
    text.push_str("\r\n");let _=stream.write_all(text.as_bytes());if !head{let _=stream.write_all(body);}
}
fn handle(mut stream:TcpStream,token:&str,base:&Url,stopped:&AtomicBool){
    let _=stream.set_read_timeout(Some(Duration::from_secs(5)));let _=stream.set_write_timeout(Some(Duration::from_secs(8)));let mut bytes=Vec::new();let mut buffer=[0u8;2048];
    while bytes.len()<16384{match stream.read(&mut buffer){Ok(0)=>return,Ok(n)=>{bytes.extend_from_slice(&buffer[..n]);if bytes.windows(4).any(|w|w==b"\r\n\r\n"){break;}},Err(_)=>return}}
    let request=String::from_utf8_lossy(&bytes);let line=request.lines().next().unwrap_or("");let parts=line.split_whitespace().collect::<Vec<_>>();if parts.len()!=3{respond(&mut stream,403,&[],b"Invalid request",false);return;}let head=parts[0]=="HEAD";
    if stopped.load(Ordering::Relaxed){respond(&mut stream,403,&[],b"Preview closed",head);return;}
    if parts[0]!="GET"&&!head{respond(&mut stream,405,&[],b"Read-only preview",false);return;}
    let path=parts[1];let prefix=format!("/{token}/");if !path.starts_with(&prefix)||path.contains('\\')||path.chars().any(|c|c.is_control()){respond(&mut stream,403,&[],b"Preview capability required",head);return;}
    let upstream_path=format!("/{}",&path[prefix.len()..]);if upstream_path.starts_with("//"){respond(&mut stream,403,&[],b"Invalid preview path",head);return;}
    let result=(||->Result<(u16,Vec<(&'static str,String)>,Vec<u8>),RuntimeError>{
        let mut target=base.clone();let (p,q)=upstream_path.split_once('?').map(|(p,q)|(p,Some(q))).unwrap_or((&upstream_path,None));target.set_path(p);target.set_query(q);
        let client=reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).no_proxy().build().map_err(|_|error("PREVIEW_FETCH","本机代理不可用"))?;
        let response=if head{client.head(target)}else{client.get(target)}.header("Accept-Encoding","identity").send().map_err(|_|error("PREVIEW_FETCH","开发服务器无法连接"))?;
        let status=response.status().as_u16();let headers=response.headers();let mut content_type=headers.get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("application/octet-stream").to_owned();
        if ["text/html","javascript","text/css"].iter().any(|kind|content_type.contains(kind)){content_type=format!("{}; charset=utf-8",content_type.split(';').next().unwrap_or("text/plain"));}
        if headers.get("content-encoding").and_then(|v|v.to_str().ok()).map(|v|v!="identity"&&!v.is_empty()).unwrap_or(false){return Err(error("PREVIEW_ENCODING","开发服务器忽略了 identity 编码请求"));}
        let mut out=vec![("Content-Type",content_type.clone()),("Content-Security-Policy",CSP.into()),("Referrer-Policy","no-referrer".into()),("X-Content-Type-Options","nosniff".into()),("Access-Control-Allow-Origin","null".into()),("Cache-Control","no-store".into())];
        if let Some(location)=headers.get("location").and_then(|v|v.to_str().ok()){
            let joined=base.join(location).map_err(|_|error("PREVIEW_REDIRECT","开发页重定向无效"))?;let redirected=source(joined.as_str(),&HashSet::new())?;if redirected.scheme()!=base.scheme()||redirected.host_str()!=base.host_str()||redirected.port_or_known_default()!=base.port_or_known_default(){return Err(error("PREVIEW_REDIRECT","预览重定向离开了已授权开发服务器"));}
            let query=redirected.query().map(|q|format!("?{q}")).unwrap_or_default();out.push(("Location",format!("/{token}{}{query}",redirected.path())));
        }
        let mut body=Vec::new();if !head{response.take((MAX_BODY+1) as u64).read_to_end(&mut body).map_err(|_|error("PREVIEW_FETCH","无法读取开发页"))?;if body.len()>MAX_BODY{return Err(error("TOO_LARGE","预览响应超过 16 MiB"));}body=rewrite(&body,&content_type,token);}Ok((status,out,body))
    })();
    if stopped.load(Ordering::Relaxed){respond(&mut stream,403,&[],b"Preview closed",head);return;}
    match result{Ok((status,headers,body))=>respond(&mut stream,status,&headers,&body,head),Err(_)=>respond(&mut stream,502,&[("Content-Type","text/plain; charset=utf-8".into())],"本机预览无法连接或重定向被阻止".as_bytes(),head)}
}
fn rewrite(bytes:&[u8],content_type:&str,token:&str)->Vec<u8>{
    if !["text/html","javascript","text/css"].iter().any(|s|content_type.contains(s)){return bytes.to_vec();}
    let source=String::from_utf8_lossy(bytes);let prefix=format!("/{token}");let raw=source.as_bytes();let mut text=String::new();let mut begin=0;let mut i=0;
    while i+1<raw.len(){if (raw[i]==b'\''||raw[i]==b'"')&&raw[i+1]==b'/'&&raw.get(i+2)!=Some(&b'/') {text.push_str(&source[begin..=i]);text.push_str(&prefix);begin=i+1;}i+=1;}
    text.push_str(&source[begin..]);if content_type.contains("text/css"){text=text.replace("url(/",&format!("url({prefix}/"));}
    if content_type.contains("text/html"){
        let script=include_str!("preview-inspector.js").replace("__TOKEN_JSON__",&serde_json::to_string(token).unwrap());let injected=format!("<base href=\"{prefix}/\"><script>{script}</script>");
        let lower=text.to_ascii_lowercase();if let Some(pos)=lower.find("<head").and_then(|start|lower[start..].find('>').map(|end|start+end+1)){text.insert_str(pos,&injected);}else{text=injected+&text;}
    }text.into_bytes()
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn only_explicit_loopback_development(){for url in ["https://localhost:5173","http://example.com:5173","http://127.0.0.2:5173","http://127.0.0.1:8765","http://user:pass@localhost:5173","file:///tmp/index.html"]{assert!(source(url,&HashSet::new()).is_err(),"{url}");}assert_eq!(source("http://localhost:5173/",&HashSet::new()).unwrap().host_str(),Some("127.0.0.1"));}
    #[test]fn injects_only_preview_protocol_and_scoped_assets(){let body=rewrite(b"<html><head></head><body><script src=\"/app.js\"></script></body></html>","text/html","abcdef");let text=String::from_utf8(body).unwrap();assert!(text.contains("/abcdef/app.js"));assert!(text.contains("koide.preview.control"));assert!(!text.contains("__TOKEN_JSON__"));assert!(!text.contains("WebSocket"));assert!(CSP.contains("form-action 'none'"));}
    #[test]fn capture_needs_live_session(){let manager=PreviewManager::new(std::env::temp_dir());assert_eq!(manager.capture("missing",1280,800).unwrap_err().code,"PREVIEW_NOT_FOUND");}
    #[test]fn closing_all_invalidates_tokens(){let mut manager=PreviewManager::new(std::env::temp_dir());let one=manager.open("http://localhost:5173/").unwrap();let two=manager.open("http://localhost:5173/").unwrap();assert_ne!(one["token"],two["token"]);assert_eq!(one["token"].as_str().unwrap().len(),64);manager.close_all();assert!(manager.sessions.is_empty());assert_eq!(manager.capture(one["id"].as_str().unwrap(),1280,800).unwrap_err().code,"PREVIEW_NOT_FOUND");}
    #[test]
    fn live_proxy_requires_capability_and_never_forwards_credentials() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let source_port=listener.local_addr().unwrap().port();
        let upstream=thread::spawn(move||{
            let(mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request=[0u8;8192];let size=socket.read(&mut request).unwrap();let request=String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
            assert!(!request.contains("cookie:"));assert!(!request.contains("authorization:"));
            respond(&mut socket,200,&[("Content-Type","text/html; charset=utf-8".into())],b"<html><head></head><body>preview</body></html>",false);
        });
        let mut manager=PreviewManager::new(std::env::temp_dir());let session=manager.open(&format!("http://127.0.0.1:{source_port}/")).unwrap();
        let url=session["url"].as_str().unwrap();let proxy=Url::parse(url).unwrap();let client=reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
        assert_eq!(client.get(format!("http://127.0.0.1:{}/rpc",proxy.port().unwrap())).send().unwrap().status().as_u16(),403);
        assert_eq!(client.post(url).send().unwrap().status().as_u16(),405);
        let response=client.get(url).header("Cookie","private=secret").header("Authorization","Bearer secret").send().unwrap();
        assert_eq!(response.status().as_u16(),200);assert_eq!(response.headers()["Content-Security-Policy"],CSP);
        assert_eq!(response.headers()["Referrer-Policy"],"no-referrer");assert!(response.text().unwrap().contains("koide.preview"));upstream.join().unwrap();
        manager.close_all();if let Ok(response)=client.get(url).send(){assert_eq!(response.status().as_u16(),403);}
    }
    #[test]
    #[ignore = "需要已安装 Chrome/Edge；显式运行验证真实浏览器截图出口"]
    fn real_capture_cannot_navigate_to_another_loopback_port() {
        assert!(browser().is_some(),"此集成回归需要 Chrome 或 Edge");
        fn page(listener:TcpListener,body:String)->(Arc<AtomicBool>,Arc<AtomicUsize>,thread::JoinHandle<()>) {
            listener.set_nonblocking(true).unwrap();let stop=Arc::new(AtomicBool::new(false));let hits=Arc::new(AtomicUsize::new(0));let stopped=stop.clone();let count=hits.clone();
            let worker=thread::spawn(move||{while !stopped.load(Ordering::SeqCst){match listener.accept(){Ok((mut socket,_))=>{socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut request=[0u8;8192];let _=socket.read(&mut request);count.fetch_add(1,Ordering::SeqCst);respond(&mut socket,200,&[("Content-Type","text/html; charset=utf-8".into())],body.as_bytes(),false);},Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(10)),Err(e)=>panic!("{e}")}}});
            (stop,hits,worker)
        }
        let forbidden=TcpListener::bind("127.0.0.1:0").unwrap();let forbidden_port=forbidden.local_addr().unwrap().port();let(deny_stop,deny_hits,deny_worker)=page(forbidden,"不可访问".into());
        let source=TcpListener::bind("127.0.0.1:0").unwrap();let source_port=source.local_addr().unwrap().port();
        let(source_stop,source_hits,source_worker)=page(source,format!("<html><head></head><body><h1>受控预览</h1><script>if(location.search)location.href='http://127.0.0.1:{forbidden_port}/secret';</script></body></html>"));
        let directory=std::env::temp_dir().join(super::super::id::unique_id("koide-native-capture-test-"));let mut manager=PreviewManager::new(directory.clone());
        let normal=manager.open(&format!("http://127.0.0.1:{source_port}/")).unwrap();let first=manager.capture(normal["id"].as_str().unwrap(),640,480);
        let navigating=manager.open(&format!("http://127.0.0.1:{source_port}/?navigate=1")).unwrap();let second=manager.capture(navigating["id"].as_str().unwrap(),640,480);
        manager.close_all();source_stop.store(true,Ordering::SeqCst);deny_stop.store(true,Ordering::SeqCst);source_worker.join().unwrap();deny_worker.join().unwrap();
        let data=first.unwrap();let png=base64::engine::general_purpose::STANDARD.decode(data["image"].as_str().unwrap().split(',').nth(1).unwrap()).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()),640);second.unwrap();assert!(source_hits.load(Ordering::SeqCst)>0);assert_eq!(deny_hits.load(Ordering::SeqCst),0);
        assert!(directory.starts_with(std::env::temp_dir()));let _=fs::remove_dir_all(directory);
    }
}
