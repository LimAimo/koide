import test from "node:test";
import assert from "node:assert/strict";
import { analyze, summarize, KIND, lcsPairs } from "../../apps/web/src/animations/diffusion/engine.js";
import { segmentBlocks, tokenize } from "../../apps/web/src/animations/diffusion/structure.js";

const kinds = (plan) => plan.atoms.map((a) => a.kind);
const count = (plan, k) => plan.atoms.filter((a) => a.kind === k).length;
const strip = (s) => s.replace(/\s+/g, "");

/** The animation must end exactly at `after`, and start exactly from `before`. */
function assertReconstructs(before, after, plan) {
  if (plan.granularity === "simplified" || !plan.changed) return;
  const rebuild = (text, side) => {
    const lines = text.split("\n");
    return lines.map((line, i) => {
      const parts = plan.atoms
        .filter((a) => a[side] && a[side].line === i)
        .sort((x, y) => x[side].col - y[side].col)
        .map((a) => (side === "from" && a.kind === "TRANSFORM" ? a.fromText : a.text));
      return strip(parts.join("")) === strip(line);
    });
  };
  const okAfter = rebuild(after.replace(/\r\n/g, "\n"), "to"), okBefore = rebuild(before.replace(/\r\n/g, "\n"), "from");
  assert.ok(okAfter.every(Boolean), "after-side atoms must rebuild every line of the new text: " + okAfter.map((v, i) => v ? "" : i).join(","));
  assert.ok(okBefore.every(Boolean), "before-side atoms must rebuild every line of the old text: " + okBefore.map((v, i) => v ? "" : i).join(","));
}

const SRC = `import os

def alpha(x):
    total = 0
    for i in range(x):
        total += i
    return total

def beta(y):
    if y > 10:
        return "big"
    return "small"

def gamma(z):
    print("gamma", z)
    return z * 2
`;

test("identical text is unchanged", () => {
  const p = analyze(SRC, SRC);
  assert.equal(p.changed, false);
});

test("tokenizer keeps identifiers, numbers and operators whole", () => {
  assert.deepEqual(tokenize("a >= 10 && b").map((t) => t.text), ["a", ">=", "10", "&&", "b"]);
  assert.deepEqual(tokenize("  foo.bar(1)").map((t) => [t.text, t.col]), [["foo", 2], [".", 5], ["bar", 6], ["(", 9], ["1", 10], [")", 11]]);
});

test("block segmentation: header + deeper lines + closer", () => {
  const lines = ["function a() {", "  x();", "}", "", "function b() {", "  y();", "}"];
  assert.deepEqual(segmentBlocks(lines), [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
  const py = ["def a():", "    x", "", "    y", "def b():", "    z"];
  assert.deepEqual(segmentBlocks(py), [{ start: 0, end: 4 }, { start: 4, end: 6 }]);
});

test("moving a whole function is a GROUP_MOVE, not delete+insert", () => {
  const after = `import os

def beta(y):
    if y > 10:
        return "big"
    return "small"

def gamma(z):
    print("gamma", z)
    return z * 2

def alpha(x):
    total = 0
    for i in range(x):
        total += i
    return total
`;
  const p = analyze(SRC, after);
  assert.equal(count(p, "DELETE"), 0);
  assert.equal(count(p, "INSERT"), 0);
  const moved = p.atoms.filter((a) => a.kind === KIND.GROUP_MOVE);
  assert.ok(moved.length >= 5, "alpha's lines move as a group");
  assert.ok(moved.every((a) => a.conf >= 0.9 && a.group === moved[0].group));
  assertReconstructs(SRC, after, p);
  assert.match(summarize(p), /moved/);
});

test("inserting a line shifts the ones below instead of redrawing them", () => {
  const after = SRC.replace("    return total\n", "    total *= 2\n    return total\n");
  const p = analyze(SRC, after);
  assert.equal(count(p, "INSERT") > 0, true);
  assert.equal(count(p, "DELETE"), 0);
  assert.ok(count(p, "LAYOUT_SHIFT") >= 5, "later lines make room");
  assertReconstructs(SRC, after, p);
});

test("a one-operator edit becomes a single TRANSFORM between KEEPs", () => {
  const before = "def add(a, b):\n    return a - b\n", after = "def add(a, b):\n    return a + b\n";
  const p = analyze(before, after);
  const t = p.atoms.filter((a) => a.kind === KIND.TRANSFORM);
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].fromText, t[0].text], ["-", "+"]);
  assert.equal(p.atoms.filter((a) => a.text === "return")[0].kind, KIND.KEEP);
  assertReconstructs(before, after, p);
});

test("a rename is a high-confidence TRANSFORM", () => {
  const p = analyze("let count = 1;\n", "let counts = 1;\n");
  const t = p.atoms.find((a) => a.kind === KIND.TRANSFORM);
  assert.equal(t.fromText, "count");
  assert.ok(t.conf >= 0.8);
});

test("unrelated replacement stays simple: DELETE + INSERT, never a fake morph", () => {
  const p = analyze("alpha beta gamma\nkeep me\n", "completely different text here\nkeep me\n");
  assert.equal(count(p, "TRANSFORM"), 0);
  assert.ok(count(p, "DELETE") > 0 && count(p, "INSERT") > 0);
});

test("ambiguous duplicate lines are not treated as moves", () => {
  const before = "a1\n}\nb2\n}\nc3\n", after = "b2\n}\na1\n}\nc3\n";
  const p = analyze(before, after);
  assert.equal(p.atoms.some((a) => a.kind === KIND.MOVE && a.text === "}"), false);
  assertReconstructs(before, after, p);
});

test("moved method inside a class keeps its closing brace via group extension", () => {
  const before = "class A {\n  one() {\n    return 1;\n  }\n  two() {\n    return 2;\n  }\n}\n";
  const after = "class A {\n  two() {\n    return 2;\n  }\n  one() {\n    return 1;\n  }\n}\n";
  const p = analyze(before, after);
  assert.equal(count(p, "DELETE"), 0, JSON.stringify(p.atoms.filter((a) => a.kind === "DELETE")));
  assert.equal(count(p, "INSERT"), 0);
  assertReconstructs(before, after, p);
});

test("budget degrades granularity: token -> line -> simplified", () => {
  const big = (n, tag) => Array.from({ length: n }, (_, i) => `line ${tag} number ${i} ${"x".repeat(i % 7)}`).join("\n");
  assert.equal(analyze(big(10, "a"), big(10, "b")).granularity, "token");
  assert.equal(analyze(big(120, "a"), big(120, "b")).granularity, "line");
  const huge = analyze(big(900, "a"), big(900, "b"));
  assert.equal(huge.granularity, "simplified");
  assert.deepEqual(huge.atoms, []);
});

test("too-expensive analysis falls back rather than freezing the phone", () => {
  const a = Array.from({ length: 4000 }, (_, i) => `a${i}`).join("\n"), b = Array.from({ length: 4000 }, (_, i) => `b${i}`).join("\n");
  const t0 = Date.now();
  const p = analyze(a, b);
  assert.equal(p.granularity, "simplified");
  assert.ok(Date.now() - t0 < 1500);
});

test("lcs is correct", () => {
  assert.deepEqual(lcsPairs(["a", "b", "c", "d"], ["a", "c", "d", "e"]), [[0, 0], [2, 1], [3, 2]]);
});

test("CRLF input is treated like LF", () => {
  const p = analyze("a\r\nb\r\n", "a\nc\n");
  assert.equal(p.changed, true);
  assert.equal(p.atoms.find((a) => a.text === "a").kind, KIND.KEEP);
});

// ---- fuzz: whatever we do to the text, the plan must reconstruct both sides exactly ----------------
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

test("fuzz: random edits always reconstruct before and after", () => {
  const rand = rng(42);
  const base = SRC.split("\n");
  const words = ["foo", "bar", "baz(1)", "x = y + 1", "}", "{", "return None", "if a:", "  pass", "total", "", "def q():"];
  for (let iter = 0; iter < 400; iter++) {
    const lines = [...base];
    const edits = 1 + Math.floor(rand() * 6);
    for (let e = 0; e < edits; e++) {
      const op = Math.floor(rand() * 5), i = Math.floor(rand() * lines.length);
      if (op === 0) lines.splice(i, 1);
      else if (op === 1) lines.splice(i, 0, words[Math.floor(rand() * words.length)]);
      else if (op === 2) lines[i] = lines[i].replace(/\w+/, words[Math.floor(rand() * words.length)]);
      else if (op === 3) { const [m] = lines.splice(i, 1); lines.splice(Math.floor(rand() * lines.length), 0, m ?? ""); }
      else { const len = 1 + Math.floor(rand() * 4), chunk = lines.splice(i, len); lines.splice(Math.floor(rand() * (lines.length + 1)), 0, ...chunk); }
    }
    const after = lines.join("\n");
    const plan = analyze(SRC, after);
    assertReconstructs(SRC, after, plan);
    for (const a of plan.atoms) {
      if (a.kind === "MOVE" || a.kind === "GROUP_MOVE") assert.ok(a.conf >= 0.7, "no low-confidence moves are ever emitted");
    }
  }
});
