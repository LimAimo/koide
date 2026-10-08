import http.client
import asyncio
import base64
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bridge.preview import PreviewManager, validate_url, browser_executable
from bridge.filesystem.workspace import WorkspaceError
from bridge.protocol.http import SECURITY_HEADERS, preview_csp, serve_static
from bridge.app import BridgeApp


class SourceHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://example.com/secret")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        if self.path == "/navigate" and hasattr(self.server, "navigate_to"):
            self.wfile.write(('<html><head></head><body><script>location.href=' + json.dumps(self.server.navigate_to) + '</script></body></html>').encode())
        else:
            self.wfile.write(b'<html><head></head><body><script src="/app.js"></script><h1>Hello</h1></body></html>')


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = ThreadingHTTPServer(("127.0.0.1", 0), SourceHandler)
        self.thread = threading.Thread(target=self.source.serve_forever, daemon=True)
        self.thread.start()
        self.manager = PreviewManager(Path(self.temp.name))

    def tearDown(self):
        self.manager.close_all()
        self.source.shutdown()
        self.source.server_close()
        self.temp.cleanup()

    def request(self, url, method="GET"):
        parsed = urlsplit(url)
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=4)
        connection.request(method, parsed.path)
        response = connection.getresponse()
        data = response.read()
        result = (response.status, dict(response.getheaders()), data)
        connection.close()
        return result

    def test_local_only_pin_and_management_ports(self):
        for url in ("https://localhost:5173", "http://example.com:5173", "http://127.0.0.2:5173", "http://127.0.0.1:8765", "http://127.0.0.1:9222", "http://user:pass@localhost:5173", "file:///tmp/index.html"):
            with self.assertRaises(WorkspaceError, msg=url):
                validate_url(url)
        self.assertEqual(validate_url("http://localhost:5173/")[0], "127.0.0.1")

    def test_token_injection_csp_no_rpc_and_read_only(self):
        session = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/")
        status, headers, body = self.request(session["url"])
        self.assertEqual(status, 200)
        self.assertIn(b"koide.preview", body)
        self.assertIn(("/" + session["token"] + "/app.js").encode(), body)
        self.assertIn("form-action 'none'", headers["Content-Security-Policy"])
        self.assertIn("charset=utf-8", headers["Content-Type"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "null")
        self.assertNotIn(b"WebSocket", body)
        root_url = session["url"].split("/" + session["token"])[0]
        self.assertEqual(self.request(root_url + "/app.js")[0], 403)
        self.assertEqual(self.request(session["url"], "POST")[0], 405)
        self.assertFalse(session["capabilities"]["websocket"])

    def test_remote_redirect_and_runtime_port_blocked(self):
        session = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/redirect")
        self.assertEqual(self.request(session["url"])[0], 502)
        manager = PreviewManager(Path(self.temp.name), blocked_ports=(self.source.server_port,))
        with self.assertRaises(WorkspaceError):
            manager.open(f"http://127.0.0.1:{self.source.server_port}/")

    def test_capture_requires_active_session_and_installed_browser(self):
        with self.assertRaises(WorkspaceError) as error:
            self.manager.capture("missing")
        self.assertEqual(error.exception.code, "PREVIEW_NOT_FOUND")
        session = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/")
        with patch("bridge.preview.browser_executable", return_value=None):
            with self.assertRaises(WorkspaceError) as error:
                self.manager.capture(session["id"])
        self.assertEqual(error.exception.code, "SCREENSHOT_UNAVAILABLE")
        self.manager.close(session["id"])
        self.assertFalse(self.manager.close(session["id"])["closed"])

    @unittest.skipUnless(browser_executable(), "没有安装 Chrome/Edge，真实截图能力不可用")
    def test_real_browser_capture_blocks_navigation_to_another_local_port(self):
        session = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/")
        image = base64.b64decode(self.manager.capture(session["id"], 640, 480)["image"].split(",", 1)[1])
        self.assertTrue(image.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertGreater(len(image), 1024)
        self.assertEqual(int.from_bytes(image[16:20], "big"), 640)
        class ForbiddenServer(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.server.hits += 1
                self.send_response(200); self.end_headers(); self.wfile.write(b"Must not be reached")
        forbidden = ThreadingHTTPServer(("127.0.0.1", 0), ForbiddenServer)
        forbidden.hits = 0
        worker = threading.Thread(target=forbidden.serve_forever, daemon=True); worker.start()
        try:
            self.source.navigate_to = f"http://127.0.0.1:{forbidden.server_port}/secret"
            redirecting = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/navigate")
            self.manager.capture(redirecting["id"], 640, 480)
            self.assertEqual(forbidden.hits, 0)
        finally:
            forbidden.shutdown(); forbidden.server_close()

    def test_close_all_invalidates_every_preview(self):
        first = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/")
        second = self.manager.open(f"http://127.0.0.1:{self.source.server_port}/")
        self.manager.close_all()
        self.assertEqual(self.manager.sessions, {})
        for session in (first, second):
            with self.assertRaises(WorkspaceError) as error:
                self.manager.capture(session["id"])
            self.assertEqual(error.exception.code, "PREVIEW_NOT_FOUND")


class PreviewLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_workspace_close_switch_and_shutdown_close_previews(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "project").mkdir()
            (root / "other").mkdir()
            app = BridgeApp(root / "data", root, root / "bridge")
            try:
                await app.rpc_workspace_open({"path": str(root / "project")}, None)
                first = await app.rpc_preview_open({"url": "http://localhost:5173/"}, None)
                await app.rpc_workspace_open({"path": str(root / "other")}, None)
                self.assertFalse(app.preview.sessions)
                second = await app.rpc_preview_open({"url": "http://localhost:5173/"}, None)
                await app.rpc_workspace_close({}, None)
                self.assertFalse(app.preview.sessions)
                await app.rpc_workspace_open({"path": str(root / "project")}, None)
                await app.rpc_preview_open({"url": "http://localhost:5173/"}, None)
                await app.shutdown()
                self.assertFalse(app.preview.sessions)
                self.assertNotEqual(first["id"], second["id"])
            finally:
                await app.shutdown()

    async def test_static_csp_is_applied_and_lan_scope_is_exact(self):
        self.assertIn("script-src 'self';", SECURITY_HEADERS["Content-Security-Policy"])
        self.assertNotIn("script-src 'self' 'unsafe-inline'", SECURITY_HEADERS["Content-Security-Policy"])
        self.assertIn("http://127.0.0.1:*", preview_csp())
        self.assertIn("http://192.168.1.20:*", preview_csp("192.168.1.20"))
        for host in ("example.com", "8.8.8.8", "evil; script-src *", "0.0.0.0"):
            self.assertEqual(preview_csp(host), preview_csp())
        class Writer:
            def __init__(self):
                self.data = b""
            def write(self, value):
                self.data += value
            async def drain(self):
                pass
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "index.html").write_text("<!doctype html>", encoding="utf-8")
            writer = Writer()
            await serve_static(writer, path, "/", "192.168.1.20")
            headers = writer.data.split(b"\r\n\r\n")[0].decode("latin-1")
            self.assertIn("Content-Security-Policy:", headers)
            self.assertIn("frame-src http://127.0.0.1:*", headers)
            self.assertIn("http://192.168.1.20:*", headers)


if __name__ == "__main__":
    unittest.main()
