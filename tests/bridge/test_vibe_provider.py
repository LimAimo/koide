"""参考图、用量诚实性、预算与阻塞网络停止的回归。"""
import asyncio
import base64
import copy
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.agent.conversations import ConversationStore
from bridge.agent.runtime import AgentRun, LimitReached, Stopped
from bridge.filesystem.workspace import WorkspaceError
from bridge.providers.anthropic import AnthropicProvider, convert_messages as anthropic_messages
from bridge.providers.gemini import GeminiProvider, convert_messages as gemini_messages
from bridge.providers.media import UsageMeter, ensure_vision, normalize_usage, user_content, validate_attachments, validate_start
from bridge.providers.openai_compat import OpenAICompatible
from bridge.providers.profiles import ProfileStore

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nimage").decode()
ATTACHMENT = {"name": "参考.png", "data_url": PNG}


class MediaTests(unittest.TestCase):
    def test_inline_image_validation_rejects_remote_svg_and_bad_mime(self):
        self.assertEqual(validate_attachments([ATTACHMENT])[0]["name"], "参考.png")
        for url in ("https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=",
                    "data:image/png;base64,!!!!", "data:image/png;base64,YQ=="):
            with self.assertRaises(ValueError):
                validate_attachments([{"data_url": url}])
        with self.assertRaises(ValueError):
            validate_attachments([ATTACHMENT] * 5)

    def test_images_remain_structured_and_require_explicit_capability(self):
        messages = [{"role": "user", "content": user_content("照着这个改", [ATTACHMENT])}]
        with self.assertRaises(ValueError):
            ensure_vision({}, messages)
        ensure_vision({"vision": True}, messages)
        a = anthropic_messages(messages)[1][0]["content"][1]
        self.assertEqual(a["source"]["media_type"], "image/png")
        self.assertEqual(a["source"]["type"], "base64")
        g = gemini_messages(messages)[1][0]["parts"][1]
        self.assertEqual(g["inlineData"]["data"], PNG.split(",")[1])
        req = OpenAICompatible._request({"model": "test", "endpoint": "http://localhost", "vision": True}, None, messages, None)
        self.assertEqual(json.loads(req.data)["messages"][0]["content"][1]["type"], "image_url")

    def test_conversation_round_trips_images_and_profile_fields(self):
        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(Path(root) / "conversations")
            conv = store.create("参考")
            store.append(conv["id"], [{"role": "user", "text": "参考", "attachments": [ATTACHMENT]}])
            self.assertEqual(store.as_messages(store.get(conv["id"]))[0]["content"][1]["image_url"]["url"], PNG)
            profiles = ProfileStore(Path(root))
            row = profiles.save({"id": "test", "kind": "openai", "vision": True,
                                 "pricing": {"input_per_million": 1, "output_per_million": 2}})
            self.assertTrue(row["vision"])
            self.assertEqual(profiles.get("test")[0]["pricing"]["output_per_million"], 2)

    def test_usage_counts_cache_and_thinking_and_never_invents_values(self):
        unknown = normalize_usage("openai", None)
        self.assertIsNone(unknown["total_tokens"])
        self.assertEqual(unknown["source"], "unknown")
        a = normalize_usage("anthropic", {"input_tokens": 10, "output_tokens": 2,
                                           "cache_read_input_tokens": 5, "cache_creation_input_tokens": 3})
        self.assertEqual(a["total_tokens"], 20)
        g = normalize_usage("gemini_native", {"promptTokenCount": 10, "candidatesTokenCount": 2,
                                              "thoughtsTokenCount": 3, "totalTokenCount": 15})
        self.assertEqual(g["output_tokens"], 5)
        self.assertEqual(normalize_usage("openai", {"prompt_tokens": True})["source"], "unknown")

    def test_budget_stops_on_known_limit_or_unknown_usage(self):
        meter = UsageMeter()
        meter.record({}, normalize_usage("openai", {"prompt_tokens": 8, "completion_tokens": 2}))
        with self.assertRaises(ValueError):
            meter.check({"max_tokens": 10})
        unknown_usage = meter.record({}, normalize_usage("openai", None))
        self.assertIsNone(unknown_usage["total_tokens"])
        self.assertIsNone(unknown_usage["input_tokens"])
        self.assertIsNone(unknown_usage["output_tokens"])
        with self.assertRaises(ValueError):
            meter.check({"max_tokens": 100})
        meter = UsageMeter()
        costs = meter.record({"pricing": {"input_per_million": 1, "output_per_million": 2}},
                             normalize_usage("openai", {"prompt_tokens": 100, "completion_tokens": 50}))
        self.assertAlmostEqual(costs["cost_usd"], .0002)
        self.assertEqual(costs["cost_source"], "configured_estimate")
        with self.assertRaises(ValueError):
            meter.check({"max_cost_usd": .0001})

    def test_start_rejects_unknown_vision_price_and_invalid_budget(self):
        with self.assertRaises(ValueError):
            validate_start({}, [ATTACHMENT], {})
        with self.assertRaises(ValueError):
            validate_start({}, [], {"max_cost_usd": 1})
        for value in (float("inf"), -1, True, "100"):
            with self.assertRaises(ValueError):
                validate_start({}, [], {"max_tokens": value})

    def test_repeat_detection_uses_actual_failure_with_other_reads_between(self):
        run = AgentRun(None, "修复", "agent", "test", {"max_repeated_failures": 2})
        run._emit = lambda *args, **kwargs: None
        call = {"name": "shell_run", "arguments": {"command": "pnpm test"}}
        run._track_failure(call, {"exit_code": 1, "output": "失败 A"})
        run._track_failure({"name": "fs_read", "arguments": {"path": "a.js"}}, {"content": "代码"})
        with self.assertRaises(LimitReached):
            run._track_failure(call, {"exit_code": 1, "output": "失败 B"})

    def test_vendor_usage_handlers_merge_anthropic_and_preserve_gemini_signature(self):
        events, state = [], {"calls": {}, "finished": False}
        provider = AnthropicProvider()
        provider.handle({"type": "message_start", "message": {"usage": {"input_tokens": 10, "output_tokens": 1}}}, events.append, state)
        provider.handle({"type": "message_delta", "usage": {"output_tokens": 4}}, events.append, state)
        self.assertEqual(events[-1]["usage"]["total_tokens"], 14)
        state = {"calls": {}, "finished": False}
        GeminiProvider().handle({"candidates": [{"content": {"parts": [{"functionCall": {"name": "read", "args": {}},
                                      "thoughtSignature": "opaque"}]}, "finishReason": "STOP"}],
                                 "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4}}, events.append, state)
        call = next(event for event in events if event["type"] == "tool_call_complete")
        self.assertEqual(call["extra_tc"]["thought_signature"], "opaque")


class CancelTests(unittest.IsolatedAsyncioTestCase):
    async def test_workspace_change_stops_before_permission_or_tool_execution(self):
        original = object()
        app = SimpleNamespace(workspace=original)
        run = AgentRun(app, "只修改原项目", "agent", "test")
        app.workspace = object()
        with self.assertRaises(Stopped):
            await run._execute({"name": "write", "id": "call", "arguments": {}}, {}, None)
        self.assertIs(run.workspace, original)
        self.assertTrue(run.cancel.is_set())

    async def test_project_instructions_do_not_bypass_workspace_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            project = Path(root) / "project"
            project.mkdir()
            (project / "AGENTS.md").write_text("不得读取的机密标记", encoding="utf-8")
            def denied(*args):
                raise WorkspaceError("OUTSIDE_WORKSPACE", "符号链接越过工作区")
            workspace = SimpleNamespace(primary=project, resolve=denied)
            app = SimpleNamespace(workspace=workspace, data_dir=Path(root))
            run = AgentRun(app, "原项目", "agent", "test")
            self.assertNotIn("不得读取的机密标记", run._system_prompt())

    async def test_workspace_change_during_approval_cannot_run_tool_in_new_project(self):
        original = object()
        handled = []
        app = SimpleNamespace(workspace=original, emit=lambda *args: None)
        async def evaluate(tool, args, workspace, *rest):
            self.assertIs(workspace, original)
            app.workspace = object()
            return SimpleNamespace(action="allow")
        app.permissions = SimpleNamespace(evaluate=evaluate)
        run = AgentRun(app, "原项目", "agent", "test")
        tool = SimpleNamespace(input_schema={"type": "object"}, title=lambda args: "写入",
                               display_name="写入", activity="working", handler=lambda *args: handled.append(args))
        with self.assertRaises(Stopped):
            await run._execute({"name": "write", "id": "call", "arguments": {}}, {"write": tool}, None)
        self.assertEqual(handled, [])

    async def test_obsolete_queued_run_never_creates_checkpoint_in_new_workspace(self):
        events = []
        app = SimpleNamespace(workspace=object(), emit=lambda *args: events.append(args))
        run = AgentRun(app, "原项目", "agent", "test")
        app.workspace = object()
        await run.run()
        self.assertIsNone(run.task_id)
        self.assertEqual(next(data["status"] for event, data in events if event == "agent.done"), "stopped")

    async def test_task_budget_stops_before_tool_and_reports_real_or_unknown_usage(self):
        for known in (True, False):
            events, requests, executed, finished = [], [], [], []
            class Provider:
                async def stream_chat(self, profile, key, messages, specs, cancel):
                    requests.append(copy.deepcopy(messages))
                    yield {"type": "tool_call_complete", "id": "call", "name": "read", "arguments": {}}
                    if known:
                        yield {"type": "usage", "usage": normalize_usage("openai", {"prompt_tokens": 10, "completion_tokens": 2})}
                    yield {"type": "finish", "reason": "tool_calls"}
            checkpoints = SimpleNamespace(start_task=lambda *args: {"id": "test"},
                                          finish_task=lambda *args: finished.append(args))
            app = SimpleNamespace(workspace=SimpleNamespace(checkpoints=checkpoints),
                profiles=SimpleNamespace(get=lambda pid: ({"kind": "openai", "vision": True}, None)),
                tools=SimpleNamespace(for_classes=lambda mode: [], openai_specs=lambda tools: None),
                permissions=SimpleNamespace(mode="autonomous", tool_settings={}),
                emit=lambda event, data: events.append((event, data)))
            run = AgentRun(app, "参考图修改", "agent", "test", {"max_tokens": 10}, attachments=[ATTACHMENT])
            run._system_prompt = lambda: "test"
            async def execute(*args):
                executed.append(args)
                return {}
            run._execute = execute
            with patch("bridge.agent.runtime.get_provider", return_value=Provider()):
                await run.run()
            self.assertEqual(executed, [])
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0][-1]["content"][1]["image_url"]["url"], PNG)
            self.assertEqual(finished[-1][1], "stopped")
            usage = next(data["usage"] for event, data in events if event == "agent.usage")
            self.assertEqual(usage["total_tokens"], 12 if known else None)

    async def test_stop_interrupts_a_stalled_ai_approval_before_any_tool_runs(self):
        ready = asyncio.Event()
        async def evaluate(*args):
            ready.set()
            await asyncio.Event().wait()
        app = SimpleNamespace(workspace=object(), permissions=SimpleNamespace(evaluate=evaluate))
        run = AgentRun(app, "修复", "agent", "test")
        run._emit = lambda *args, **kwargs: None
        tool = SimpleNamespace(input_schema={"type": "object"}, title=lambda args: "读取",
                               display_name="读取", activity="working")
        task = asyncio.create_task(run._execute({"name": "read", "id": "call", "arguments": {}}, {"read": tool}, None))
        await asyncio.wait_for(ready.wait(), 1)
        run.cancel.set()
        with self.assertRaises(Stopped):
            await asyncio.wait_for(task, .8)

    async def test_cancel_does_not_wait_for_stalled_response(self):
        ready, release = threading.Event(), threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.flush()
                ready.set()
                release.wait(3)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        cancel = asyncio.Event()
        profile = {"kind": "openai", "model": "test", "endpoint": f"http://127.0.0.1:{server.server_port}"}
        async def consume():
            return [event async for event in OpenAICompatible().stream_chat(profile, None, [{"role": "user", "content": "test"}], None, cancel)]
        task = asyncio.create_task(consume())
        try:
            self.assertTrue(await asyncio.to_thread(ready.wait, 2))
            before = time.monotonic()
            cancel.set()
            self.assertEqual(await asyncio.wait_for(task, .8), [])
            self.assertLess(time.monotonic() - before, .8)
        finally:
            release.set()
            await asyncio.to_thread(server.shutdown)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
