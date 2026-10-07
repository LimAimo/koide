"""Tiny HTTP layer: request parsing, JSON responses, and safe static serving."""
from __future__ import annotations

import asyncio
import json
import ipaddress
import mimetypes
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")

MAX_BODY = 64 * 1024 * 1024
PREVIEW_FRAME_SOURCES = "http://127.0.0.1:* http://localhost:*"

STATUS_TEXT = {
    101: "Switching Protocols", 200: "OK", 204: "No Content", 400: "Bad Request",
    401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    413: "Payload Too Large", 500: "Internal Server Error",
}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; "
        "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; "
        f"frame-src {PREVIEW_FRAME_SOURCES}"
    ),
}


def preview_csp(host: str | None = None) -> str:
    """LAN preview may use another port on the exact private address serving the IDE."""
    policy = SECURITY_HEADERS["Content-Security-Policy"]
    if not host:
        return policy
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return policy
    if address.is_private and not address.is_unspecified and not address.is_multicast and not address.is_loopback and "%" not in str(address):
        authority = f"[{address}]" if address.version == 6 else str(address)
        return policy + f" http://{authority}:*"
    return policy


@dataclass
class Request:
    method: str
    path: str
    query: dict
    headers: dict
    body: bytes = b""
    peer: str = ""
    raw_target: str = ""

    def json(self):
        return json.loads(self.body.decode("utf-8") or "{}")


async def read_request(reader: asyncio.StreamReader) -> Request | None:
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        return None
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, target, _ = lines[0].split(" ", 2)
    except ValueError:
        return None
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    parsed = urllib.parse.urlsplit(target)
    body = b""
    length = int(headers.get("content-length", "0") or 0)
    if length:
        if length > MAX_BODY:
            return Request(method, "/__too_large__", {}, headers)
        body = await reader.readexactly(length)
    return Request(method.upper(), urllib.parse.unquote(parsed.path),
                   urllib.parse.parse_qs(parsed.query), headers, body, raw_target=target)


async def write_response(writer: asyncio.StreamWriter, status: int, body: bytes = b"",
                         headers: dict | None = None) -> None:
    hdrs = {"Content-Length": str(len(body)), "Connection": "close", **SECURITY_HEADERS}
    if headers:
        hdrs.update(headers)
    out = [f"HTTP/1.1 {status} {STATUS_TEXT.get(status, 'OK')}"]
    out += [f"{k}: {v}" for k, v in hdrs.items()]
    writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1") + body)
    await writer.drain()


async def write_json(writer, status: int, obj) -> None:
    await write_response(writer, status, json.dumps(obj).encode("utf-8"),
                         {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"})


async def serve_static(writer, web_dir: Path, url_path: str, csp_host: str | None = None) -> None:
    rel = url_path.lstrip("/") or "index.html"
    target = (web_dir / rel).resolve()
    root = web_dir.resolve()
    if root != target and root not in target.parents:
        return await write_response(writer, 403, b"forbidden")
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        return await write_response(writer, 404, b"not found")
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype.endswith("json") or ctype.endswith("javascript"):
        ctype += "; charset=utf-8"
    await write_response(writer, 200, target.read_bytes(),
                         {"Content-Type": ctype, "Cache-Control": "no-cache", "Content-Security-Policy": preview_csp(csp_host)})
