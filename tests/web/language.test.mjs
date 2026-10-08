import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../apps/web/vendor/language.js";

const a = 'export function answer(value: number): number { return value + 1; }\n';
const b = 'import { answer } from "./a";\nconst result = answer(2);\nconst literal = "answer"; // answer stays a comment\nfunction local() { const answer = 99; return answer; }\n';
const files = [{ path: "a.ts", content: a, revision: "a1" }, { path: "b.ts", content: b, revision: "b1" }];
const position = b.indexOf("answer(2)") + 2;

test("真实 TS 诊断支持跨文件模块、DOM 标准库与简体中文错误", () => {
  const good = analyze({ operation: "diagnostics", files: [...files, { path: "dom.ts", content: 'document.querySelector("body");', revision: "1" }] });
  assert.deepEqual(good.issues, []);
  const bad = analyze({ operation: "diagnostics", files: [{ path: "wrong.ts", content: 'const amount: number = "不是数字";', revision: "1" }] });
  assert.equal(bad.issues[0].code, 2322);
  assert.match(bad.issues[0].message, /不能将类型/);
  assert.equal(bad.issues[0].path, "wrong.ts");
  assert.equal(bad.issues[0].line, 1);
});

test("定义与引用按真实符号解析，排除同名局部变量、字符串和注释", () => {
  const definition = analyze({ operation: "definition", files, path: "b.ts", position });
  assert.equal(definition.locations.length, 1);
  assert.equal(definition.locations[0].path, "a.ts");
  assert.equal(definition.locations[0].offset, a.indexOf("answer"));
  const refs = analyze({ operation: "references", files, path: "a.ts", position: a.indexOf("answer") + 2 });
  assert.equal(refs.locations.length, 3);
  assert.ok(refs.locations.every((r) => r.path !== "b.ts" || r.offset < b.indexOf("const literal")));
});

test("语义重命名返回基础 revision 和降序编辑，保持无关同名文本", () => {
  const result = analyze({ operation: "rename", files, path: "a.ts", position: a.indexOf("answer") + 2, new_name: "calculate" });
  assert.equal(result.files.length, 2);
  const applied = {};
  for (const f of result.files) {
    const original = files.find((x) => x.path === f.path); assert.equal(f.revision, original.revision);
    assert.ok(f.edits.every((e, i) => i === 0 || f.edits[i - 1].from > e.from));
    let content = original.content;
    for (const e of f.edits) content = content.slice(0, e.from) + e.insert + content.slice(e.to);
    applied[f.path] = content;
  }
  assert.match(applied["a.ts"], /function calculate/);
  assert.match(applied["b.ts"], /calculate\(2\)/);
  assert.match(applied["b.ts"], /"answer"; \/\/ answer stays/);
  assert.match(applied["b.ts"], /const answer = 99; return answer/);
});

test("重命名拒绝关键字、非法标识符与字符串位置", () => {
  for (const new_name of ["const", "two words", "a-b", ""]) assert.throws(() => analyze({ operation: "rename", files, path: "a.ts", position: a.indexOf("answer") + 2, new_name }), /标识符/);
  assert.throws(() => analyze({ operation: "rename", files, path: "b.ts", position: b.indexOf('"answer"') + 2, new_name: "other" }));
});

test("语言服务只接受有界项目快照", () => {
  assert.throws(() => analyze({ operation: "diagnostics", files: Array.from({ length: 1001 }, (_, i) => ({ path: `${i}.ts`, content: "", revision: "1" })) }), /1000/);
});
