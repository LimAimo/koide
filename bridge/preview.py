"""与 IDE RPC 隔离的只读本机开发页代理。令牌是能力，网页不获得工作区权限。"""
from __future__ import annotations

import base64
import http.client
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

from .filesystem.workspace import WorkspaceError

MAX_RESPONSE = 16 * 1024 * 1024
BLOCKED_PORTS = {2375, 2376, 5432, 6379, 8765, 9222, 9223, 27017}
CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'"


def validate_url(url: str, blocked: set[int] | None = None) -> tuple[str, int, str]:
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 32 for c in url):
        raise WorkspaceError("PREVIEW_URL", "预览地址无效")
    try:
        parsed = urlsplit(url)
        port = parsed.port or 80
    except ValueError:
        raise WorkspaceError("PREVIEW_URL", "预览地址无效")
    host = parsed.hostname
    if parsed.scheme != "http" or host not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password:
        raise WorkspaceError("PREVIEW_URL", "预览只接受本机开发服务器的 HTTP 地址")
    if port < 1024 or port in BLOCKED_PORTS or port in (blocked or set()):
        raise WorkspaceError("PREVIEW_PORT", "此端口属于运行时或管理服务，不能用作项目预览")
    # Pin localhost to a numeric address. No DNS resolution or redirect may expand the boundary.
    return "::1" if host == "::1" else "127.0.0.1", port, urlunsplit(("", "", parsed.path or "/", parsed.query, ""))


def inspector(token: str) -> str:
    return """<script>(()=>{'use strict';const token=TOKEN;const prefix='/'+token;
const send=(event,data)=>parent.postMessage({type:'koide.preview',token,event,data},'*');
const str=x=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}};
for(const level of ['log','info','warn','error']){const old=console[level].bind(console);console[level]=(...args)=>{old(...args);send('console',{level,text:args.map(str).join(' ').slice(0,4000),time:Date.now()})}}
addEventListener('error',e=>send('error',{message:String(e.message||'资源加载失败').slice(0,4000),filename:String(e.filename||''),line:e.lineno||0,column:e.colno||0}));
addEventListener('unhandledrejection',e=>send('error',{message:str(e.reason).slice(0,4000)}));
const rewrite=u=>typeof u==='string'&&u.startsWith('/')&&!u.startsWith('//')&&!u.startsWith(prefix+'/')?prefix+u:u;
const fetch0=window.fetch.bind(window);window.fetch=(u,o)=>fetch0(typeof u==='string'?rewrite(u):u,o);
const open0=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...rest){return open0.call(this,m,rewrite(u),...rest)};
let picking=false;let mark;const selector=el=>{if(el.id)return '#'+CSS.escape(el.id);const p=[];for(let e=el;e&&p.length<5;e=e.parentElement){let s=e.tagName.toLowerCase();if(e.classList.length)s+='.'+Array.from(e.classList).slice(0,2).map(CSS.escape).join('.');p.unshift(s)}return p.join(' > ')};
addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='koide.preview.control'||e.data.token!==token)return;picking=!!e.data.inspect;if(!picking&&mark)mark.remove()});
addEventListener('pointermove',e=>{if(!picking)return;const el=e.target;if(!el||el===mark)return;const r=el.getBoundingClientRect();if(!mark){mark=document.createElement('div');mark.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #59d6c9;background:#59d6c922;box-sizing:border-box'}document.documentElement.append(mark);Object.assign(mark.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'})},true);
addEventListener('click',e=>{if(!picking)return;e.preventDefault();e.stopImmediatePropagation();const el=e.target,r=el.getBoundingClientRect(),s=getComputedStyle(el);send('element',{selector:selector(el),tag:el.tagName.toLowerCase(),text:String(el.textContent||'').slice(0,500),rect:{x:r.x,y:r.y,width:r.width,height:r.height},styles:{color:s.color,background:s.backgroundColor,fontSize:s.fontSize,padding:s.padding,gap:s.gap}})},true);
addEventListener('DOMContentLoaded',()=>send('console',{level:'info',text:'预览已连接；当前代理为只读，修改后可点击刷新',time:Date.now()}));})();</script>""".replace("TOKEN", json.dumps(token))


def rewrite_body(data: bytes, content_type: str, token: str) -> bytes:
    if not any(t in content_type for t in ("text/html", "javascript", "text/css")):
        return data
    text = data.decode("utf-8", "replace")
    prefix = "/" + token
    # Absolute same-server asset/import paths must stay inside the bearer path.
    text = re.sub(r"([\"'])/(?!/)([^\"'\n\r]*)\1", lambda match: match[1] + prefix + "/" + match[2] + match[1], text)
    if "text/css" in content_type:
        text = re.sub(r"url\(/(?!/)", "url(" + prefix + "/", text)
    if "text/html" in content_type:
        injected = '<base href="' + prefix + '/">' + inspector(token)
        match = re.search(r"<head\b[^>]*>", text, re.I)
        text = text[:match.end()] + injected + text[match.end():] if match else injected + text
    return text.encode("utf-8")


def browser_executable() -> Path | None:
    candidates = []
    if os.name == "nt":
        for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = os.environ.get(variable)
            if root:
                candidates.extend([Path(root) / "Microsoft/Edge/Application/msedge.exe", Path(root) / "Google/Chrome/Application/chrome.exe"])
    else:
        for path in ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
            candidates.append(Path(path))
    return next((path for path in candidates if path.is_file()), None)


class PreviewServer(ThreadingHTTPServer):
    """Small bounded server: unknown clients cannot allocate unlimited idle workers."""
    def __init__(self, address, handler):
        self.workers = threading.BoundedSemaphore(8)
        super().__init__(address, handler)

    def process_request(self, request, client_address) -> None:
        if not self.workers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.workers.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.workers.release()


class PreviewManager:
    def __init__(self, data_dir: Path, lan: bool = False, blocked_ports: tuple[int, ...] = ()):
        self.data_dir = Path(data_dir) / "preview"
        self.lan = lan
        self.blocked_ports = set(blocked_ports)
        self.sessions: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.capture_lock = threading.Lock()

    def open(self, url: str, public_host: str | None = None) -> dict:
        host, port, entry = validate_url(url, self.blocked_ports)
        with self.lock:
            if len(self.sessions) >= 4:
                raise WorkspaceError("PREVIEW_LIMIT", "最多同时打开 4 个预览，请先关闭不需要的预览")
            token = secrets.token_hex(32)
            session: dict = {"host": host, "port": port, "token": token, "entry": entry, "created_at": time.time(), "closed": False}

            class Handler(BaseHTTPRequestHandler):
                def setup(self) -> None:
                    super().setup()
                    self.connection.settimeout(8)

                def log_message(self, *args) -> None:
                    pass

                def do_GET(self) -> None:
                    self._proxy(False)

                def do_HEAD(self) -> None:
                    self._proxy(True)

                def _proxy(self, head: bool) -> None:
                    raw = self.path
                    prefix = "/" + token + "/"
                    if session["closed"] or not raw.startswith(prefix) or "\\" in raw or any(ord(c) < 32 for c in raw):
                        self.send_error(403, "Preview capability required")
                        return
                    path = "/" + raw[len(prefix):]
                    if path.startswith("//"):
                        self.send_error(403, "Invalid preview path")
                        return
                    conn = http.client.HTTPConnection(host, port, timeout=8)
                    try:
                        conn.request("HEAD" if head else "GET", path, headers={"Accept-Encoding": "identity"})
                        response = conn.getresponse()
                        # Redirects are never followed and must stay on the same approved origin.
                        location = response.getheader("Location")
                        if location:
                            numeric = f"[{host}]" if ":" in host else host
                            rh, rp, rel = validate_url(urljoin(f"http://{numeric}:{port}{path}", location))
                            if rh != host or rp != port:
                                raise WorkspaceError("PREVIEW_REDIRECT", "预览重定向离开了已授权开发服务器")
                            location = "/" + token + rel
                        data = response.read(MAX_RESPONSE + 1) if not head else b""
                        if len(data) > MAX_RESPONSE:
                            raise WorkspaceError("TOO_LARGE", "预览响应超过 16 MiB")
                        content_type = response.getheader("Content-Type", "application/octet-stream")
                        if response.getheader("Content-Encoding", "identity") not in {"", "identity"}:
                            raise WorkspaceError("PREVIEW_ENCODING", "开发服务器忽略了 identity 编码请求")
                        data = rewrite_body(data, content_type, token)
                        if session["closed"]:
                            raise WorkspaceError("PREVIEW_NOT_FOUND", "预览已经关闭")
                        if any(kind in content_type for kind in ("text/html", "javascript", "text/css")):
                            content_type = content_type.split(";", 1)[0] + "; charset=utf-8"
                        self.send_response(response.status)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Content-Length", str(len(data)))
                        self.send_header("Content-Security-Policy", CSP)
                        self.send_header("Referrer-Policy", "no-referrer")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        # Sandboxed module scripts use an opaque Origin; this server contains
                        # only bearer-scoped preview data and never accepts credentials.
                        self.send_header("Access-Control-Allow-Origin", "null")
                        self.send_header("Cache-Control", "no-store")
                        if location:
                            self.send_header("Location", location)
                        self.end_headers()
                        if not head:
                            self.wfile.write(data)
                    except (OSError, http.client.HTTPException, WorkspaceError):
                        self.send_error(502, "Local preview unavailable")
                    finally:
                        conn.close()

                def do_POST(self) -> None:
                    self.send_error(405, "Read-only preview")

            server = PreviewServer(("0.0.0.0" if self.lan else "127.0.0.1", 0), Handler)
            server.daemon_threads = True
            session["server"] = server
            session["thread"] = threading.Thread(target=server.serve_forever, daemon=True)
            session["thread"].start()
            self.sessions[token] = session
            target_host = "127.0.0.1"
            if self.lan and public_host:
                try:
                    address = ipaddress.ip_address(public_host)
                    if address.is_private and not address.is_unspecified and not address.is_multicast:
                        target_host = f"[{address}]" if address.version == 6 else str(address)
                except ValueError:
                    pass
            session["url"] = f"http://127.0.0.1:{server.server_port}/{token}{entry}"
            capabilities = {"inspect": True, "console": True, "screenshot": browser_executable() is not None, "websocket": False, "forms": False, "read_only": True}
            return {"id": token, "token": token, "url": f"http://{target_host}:{server.server_port}/{token}{entry}", "source_url": url, "capabilities": capabilities, "notice": "只读预览支持元素检查、控制台和截图；提交表单与 WebSocket 暂不可用，修改后请刷新。"}

    def close(self, session_id: str) -> dict:
        with self.lock:
            session = self.sessions.pop(session_id, None)
        if session:
            session["closed"] = True
            session["server"].shutdown()
            session["server"].server_close()
        return {"closed": session is not None}

    def close_all(self) -> None:
        for session_id in list(self.sessions):
            self.close(session_id)

    def capture(self, session_id: str, width: int = 1280, height: int = 800) -> dict:
        if not self.capture_lock.acquire(blocking=False):
            raise WorkspaceError("PREVIEW_BUSY", "已有截图正在生成，请稍候")
        try:
            return self._capture_browser(session_id, width, height)
        finally:
            self.capture_lock.release()

    def _capture_browser(self, session_id: str, width: int = 1280, height: int = 800) -> dict:
        with self.lock:
            session = self.sessions.get(session_id)
        if session is None:
            raise WorkspaceError("PREVIEW_NOT_FOUND", "预览已关闭，请重新打开")
        executable = browser_executable()
        if executable is None:
            raise WorkspaceError("SCREENSHOT_UNAVAILABLE", "未找到 Chrome 或 Edge，可安装浏览器或添加手动截图附件")
        if not isinstance(width, int) or not isinstance(height, int) or not 320 <= width <= 2560 or not 240 <= height <= 2560:
            raise WorkspaceError("BAD_PARAMS", "截图尺寸须在 320×240 与 2560×2560 之间")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="capture-", dir=self.data_dir) as directory:
            directory = Path(directory)
            output = directory / "screenshot.png"
            port = session["server"].server_port
            # 只直接连接此预览端口。其他 HTTP/HTTPS 导航进入不支持 CONNECT 的只读代理，禁止兜底直连。
            args = [str(executable), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-extensions", "--disable-background-networking", f"--proxy-server=http://127.0.0.1:{port}", f"--proxy-bypass-list=<-loopback>;http://127.0.0.1:{port}", f"--user-data-dir={directory / 'profile'}", f"--window-size={width},{height}", "--virtual-time-budget=1500", f"--screenshot={output}", session["url"]]
            options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            try:
                result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, **options)
                data = output.read_bytes() if output.is_file() else b""
            except (OSError, subprocess.TimeoutExpired):
                raise WorkspaceError("SCREENSHOT_UNAVAILABLE", "浏览器截图未完成，可重试或添加手动截图附件")
            if result.returncode != 0 or not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_RESPONSE:
                raise WorkspaceError("SCREENSHOT_UNAVAILABLE", "浏览器没有生成有效截图")
            if session["closed"]:
                raise WorkspaceError("PREVIEW_NOT_FOUND", "预览已经关闭，截图已丢弃")
            image = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
            return {"id": session_id, "image": image, "data_url": image, "width": width, "height": height, "captured_at": time.time(), "source": "browser"}
