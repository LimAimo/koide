"""Server: one port serves the web app (static), /ws (WebSocket bridge) and a tiny pairing API.

Security posture
  * binds 127.0.0.1 unless --lan is passed
  * Host header must be loopback in local mode (DNS-rebinding defence)
  * WebSocket Origin must match Host (cross-site page defence)
  * in LAN mode, non-loopback peers need a device token obtained by pairing
"""
from __future__ import annotations

import asyncio
import time
import urllib.parse
from pathlib import Path

from .app import VERSION, BridgeApp, Connection
from .filesystem.exporter import make_zip
from .protocol.http import Request, read_request, serve_static, write_json, write_response
from .protocol.ws import WebSocket, WebSocketClosed, accept_key

LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


def _host_only(hostport: str) -> str:
    h = hostport.strip()
    if h.startswith("["):
        return h[1:h.find("]")]
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


def _origin_ok(req: Request) -> bool:
    origin = req.headers.get("origin")
    if not origin:
        return True                     # non-browser clients (tests, CLI tools)
    o = urllib.parse.urlsplit(origin)
    return (o.netloc or "").lower() == req.headers.get("host", "").lower()


async def handle_client(app: BridgeApp, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = (writer.get_extra_info("peername") or ("", 0))[0]
    try:
        req = await read_request(reader)
        if req is None:
            return
        req.peer = peer
        if not app.lan and _host_only(req.headers.get("host", "")) not in ("127.0.0.1", "localhost", "::1"):
            return await write_response(writer, 403, b"forbidden host")

        if req.path == "/ws" and req.headers.get("upgrade", "").lower() == "websocket":
            return await handle_ws(app, req, reader, writer)
        if req.path == "/api/info" and req.method == "GET":
            return await write_json(writer, 200, {"name": "Diffusion Bridge", "version": VERSION, "lan": app.lan,
                                                  "needs_pairing": app.lan and peer not in LOOPBACK})
        if req.path == "/api/pair" and req.method == "POST":
            if not app.lan:
                return await write_json(writer, 403, {"error": "局域网模式未开启"})
            try:
                body = req.json()
            except ValueError:
                return await write_json(writer, 400, {"error": "请求格式错误"})
            token = await asyncio.to_thread(app.devices.pair, str(body.get("code", "")), str(body.get("name", "")))
            if not token:
                return await write_json(writer, 401, {"error": "配对码无效或已过期"})
            return await write_json(writer, 200, {"token": token})
        if req.path == "/api/export" and req.method == "GET":
            tok = (req.query.get("t") or [None])[0]
            entry = app.export_tokens.pop(tok, None) if tok else None      # 一次性令牌
            if not entry or entry[1] < time.time():
                return await write_json(writer, 404, {"error": "下载链接无效或已过期"})
            try:
                f, size, name = await asyncio.to_thread(make_zip, Path(entry[0]))
            except ValueError as e:
                return await write_json(writer, 413, {"error": str(e)})
            head = (f"HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {size}\r\n"
                    f"Content-Disposition: attachment; filename*=UTF-8''{urllib.parse.quote(name)}\r\n"
                    "Cache-Control: no-store\r\nConnection: close\r\n\r\n")
            writer.write(head.encode("latin-1"))
            while True:
                chunk = await asyncio.to_thread(f.read, 65536)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
            f.close()
            return
        if req.method in ("GET", "HEAD") and req.path.startswith("/animation-packs/"):
            return await serve_static(writer, app.packs_dir, req.path[len("/animation-packs/"):])
        if req.method in ("GET", "HEAD"):
            return await serve_static(writer, app.web_dir, req.path, _host_only(req.headers.get("host", "")) if app.lan else None)
        await write_response(writer, 405, b"method not allowed")
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_ws(app: BridgeApp, req: Request, reader, writer) -> None:
    if not _origin_ok(req):
        return await write_response(writer, 403, b"cross-origin websocket refused")
    device = None
    if req.peer not in LOOPBACK:
        if not app.lan:
            return await write_response(writer, 403, b"local connections only")
        device = app.devices.verify((req.query.get("token") or [None])[0])
        if device is None:
            return await write_response(writer, 401, b"pair this device first")
    key = req.headers.get("sec-websocket-key")
    if not key:
        return await write_response(writer, 400, b"missing key")
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n").encode())
    await writer.drain()
    ws = WebSocket(reader, writer)
    conn = Connection(ws, req.peer, device)
    app.add_connection(conn)
    try:
        while True:
            msg = await ws.recv()
            if isinstance(msg, str):
                asyncio.create_task(app.handle_message(conn, msg))
    except WebSocketClosed:
        pass
    finally:
        app.remove_connection(conn)
        await ws.close()


async def serve(app: BridgeApp, host: str, port: int) -> asyncio.AbstractServer:
    app.loop = asyncio.get_running_loop()
    return await asyncio.start_server(lambda r, w: handle_client(app, r, w), host, port, limit=2 ** 20)
