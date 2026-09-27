import test from "node:test";
import assert from "node:assert/strict";
import { indexSource, linkProject } from "../../packages/editor-cm6/src/semantic.js";

test("索引来自语法树，注释/字符串里的假函数不产生定义", async () => {
  const unit = await indexSource("a.js", '// function fake() {}\nconst text = "function nope() {}";\nexport function actual() { return 1; }\nactual();');
  assert.ok(unit.symbols.some((s) => s.name === "actual" && s.kind === "function"));
  assert.ok(!unit.symbols.some((s) => ["fake", "nope"].includes(s.name)));
  const graph = linkProject([unit]);
  assert.ok(graph.edges.some((e) => e.kind === "call" && e.name === "actual" && e.to));
});

test("具名导入别名连接到真实定义，动态成员不冒充确定调用", async () => {
  const units = await Promise.all([indexSource("src/a.js", 'export function work() {}'), indexSource("src/b.js", 'import { work as run } from "./a.js";\nrun();\nunknown.work();')]);
  const graph = linkProject(units);
  assert.ok(graph.edges.some((e) => e.name === "run" && e.kind === "call" && e.to?.startsWith("src/a.js:")));
  assert.ok(graph.edges.some((e) => e.name === "unknown.work" && !e.to && e.confidence === "dynamic"));
});
