import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fake-dom.mjs";
installFakeDom();
const { executionGraph, actionRationale } = await import("../../apps/web/src/services/engineering.js");
const { compareVisual } = await import("../../apps/web/src/services/visual-regression.js");

test("计划修订不能伪装成执行，失败与中断保留实际调用", () => {
  const task = { goal: "修复", events: [
    { seq: 0, type: "plan", record: { nodes: [{ id: "old", title: "旧方案" }] } },
    { seq: 1, type: "plan", record: { nodes: [{ id: "check", title: "验证", kind: "validate", command: "pnpm test" }, { id: "skip", title: "未执行", kind: "edit" }] } },
    { seq: 2, type: "tool_started", call_id: "call", tool: "shell_run", arguments: { command: "pnpm test", plan_node_id: "check" } },
    { seq: 3, type: "tool_result", call_id: "call", state: "error" },
  ] };
  const model = executionGraph(task);
  assert.equal(model.replaced.length, 1);
  assert.equal(model.nodes[0].status, "failed");
  assert.equal(model.nodes[1].status, "skipped");
  task.events.pop();
  assert.equal(executionGraph(task).nodes[0].status, "interrupted");
  assert.equal(executionGraph(task, true).nodes[0].status, "running");
});

test("读取动作不能把验证计划标为完成，Why 不补造理由", () => {
  const task = { goal: "验证", events: [{ seq: 0, type: "plan", record: { nodes: [{ id: "v", kind: "validate", command: "test" }] } }, { seq: 1, type: "tool_started", call_id: "c", tool: "fs_read", arguments: { plan_node_id: "v", path: "a.js" } }, { seq: 2, type: "tool_result", call_id: "c", state: "done" }] };
  assert.equal(executionGraph(task).nodes[0].status, "partial");
  assert.equal(actionRationale(task, task.events[1]).proposed_reason, null);
});

test("视觉回归隔离视口与主题，预期变化和纯截图变化不等同失败", () => {
  const before = { viewport: { width: 360, height: 720 }, theme: "dark", image: "a", nodes: [{ key: "send", x: 0, y: 0, width: 40, height: 40, overflow: false }] };
  const after = structuredClone(before); after.image = "b";
  assert.equal(compareVisual(before, after).unexpected.length, 0);
  after.nodes[0].width = 80;
  assert.equal(compareVisual(before, after).unexpected.length, 1);
  assert.equal(compareVisual(before, after, ["send"]).unexpected.length, 0);
  after.viewport.width = 768;
  assert.equal(compareVisual(before, after).compatible, false);
});
