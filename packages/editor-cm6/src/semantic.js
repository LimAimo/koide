import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const FUNCTION = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunction", "MethodDeclaration", "FunctionDefinition", "FunctionItem", "ClosureExpression"]);
const CLASS = new Set(["ClassDeclaration", "ClassExpression", "ClassDefinition", "StructItem", "EnumItem", "TraitItem", "InterfaceDeclaration"]);
const SCOPE = new Set([...FUNCTION, ...CLASS, "Block", "Body", "ClassBody", "ParamList", "Script", "SourceFile"]);
const NAMES = new Set(["VariableDefinition", "VariableName", "BoundIdentifier", "Identifier", "PropertyDefinition", "TypeDefinition", "TypeIdentifier", "PropertyName"]);
const text = (source, node) => source.slice(node.from, node.to);
const children = (node) => { const out = []; for (let n = node.firstChild; n; n = n.nextSibling) out.push(n); return out; };
const unquote = (s) => { if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return null; } } return s.startsWith("'") && !s.includes("\\") ? s.slice(1, -1) : null; };

/** Syntax-derived symbols and relationships. Dynamic dispatch remains unresolved. */
export async function indexSource(path, source) {
  const description = LanguageDescription.matchFilename(languages, path);
  if (!description || !/\.(?:[cm]?[jt]sx?|py|rs|css|html?)$/i.test(path)) return { path, unsupported: true, symbols: [], edges: [], imports: [] };
  const support = await description.load();
  const parser = support.language?.parser;
  if (!parser) return { path, unsupported: true, symbols: [], edges: [], imports: [] };
  const tree = parser.parse(source), symbols = [], references = [], imports = [], endpoints = [];
  const lineOffsets = [0]; for (let p = source.indexOf("\n"); p >= 0; p = source.indexOf("\n", p + 1)) lineOffsets.push(p + 1);
  const line = (at) => { let lo = 0, hi = lineOffsets.length; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (lineOffsets[mid] <= at) lo = mid; else hi = mid; } return lo + 1; };
  const defined = new Set(); let errors = 0, visited = 0;
  function visit(node, scopes, owner, properties) {
    if (++visited > 60000) return;
    if (node.type.isError) errors++;
    const name = node.name, list = children(node);
    let nextOwner = owner, nextProperties = properties;
    if (name === "Property") {
      const key = list.find((n) => n.name === "PropertyDefinition");
      if (key) nextProperties = [...properties, text(source, key)];
    }
    if (FUNCTION.has(name) || CLASS.has(name)) {
      const identity = list.find((n) => NAMES.has(n.name));
      let label = identity ? text(source, identity) : null;
      if (!label && node.parent?.name === "VariableDeclaration") {
        const assigned = children(node.parent).find((n) => n.name === "VariableDefinition");
        if (assigned) label = text(source, assigned);
      }
      if (!label) label = properties.at(-1) || `回调@${line(node.from)}`;
      const scope = scopes.at(-1) || tree.topNode;
      const id = `${path}:${node.from}:${label}`;
      symbols.push({ id, path, name: label, kind: CLASS.has(name) ? "class" : "function", line: line(node.from), end_line: line(node.to), from: node.from, to: node.to, scope_from: scope.from, scope_to: scope.to, owner, exported: node.parent?.name === "ExportDeclaration" });
      if (identity) defined.add(identity.from);
      nextOwner = id;
    } else if (name === "VariableDefinition" || name === "BoundIdentifier") {
      if (!defined.has(node.from) && !children(node.parent || node).some((n) => FUNCTION.has(n.name))) {
        const scope = [...scopes].reverse().find((s) => s.name !== "ParamList") || tree.topNode;
        symbols.push({ id: `${path}:${node.from}:${text(source, node)}`, path, name: text(source, node), kind: "binding", line: line(node.from), end_line: line(node.to), from: node.from, to: node.to, scope_from: scope.from, scope_to: scope.to, owner });
        defined.add(node.from);
      }
    }
    if (name === "PropertyDefinition" && node.parent?.name === "Property") {
      symbols.push({ id: `${path}:${node.from}:property`, path, name: nextProperties.join(".") || text(source, node), kind: "property", line: line(node.from), end_line: line(node.parent.to), from: node.from, to: node.parent.to, scope_from: node.parent.from, scope_to: node.parent.to, owner });
    }
    if (/^(ImportDeclaration|ImportStatement|UseDeclaration)$/.test(name)) {
      const raw = text(source, node);
      const literal = list.find((n) => n.name === "String");
      const module = literal ? unquote(text(source, literal)) : raw.match(/(?:from|import|use)\s+([.\w:]+)/)?.[1];
      if (module) imports.push({ path, module, line: line(node.from), raw, from: node.from, to: node.to });
    }
    if (name === "CallExpression") {
      const callee = list[0], args = list.find((n) => n.name === "ArgList");
      if (callee) {
        const call = text(source, callee);
        references.push({ kind: "call", name: call, path, line: line(node.from), from: node.from, owner: nextOwner || `file:${path}`, scope_from: scopes.at(-1)?.from || 0 });
        const literal = args && children(args).find((n) => n.name === "String");
        const method = literal && unquote(text(source, literal));
        if (call === "call" && method?.includes(".") && /services\/runtime\/index\.js$/.test(path)) endpoints.push({ method, accessor: `runtime.${properties.join(".")}`, path, line: line(node.from), id: `runtime:${method}` });
      }
    } else if (name === "VariableName" || name === "Identifier" || name === "MemberExpression" || name === "FieldExpression") {
      if (!defined.has(node.from)) references.push({ kind: name.includes("Expression") ? "member" : "reference", name: text(source, node), path, line: line(node.from), from: node.from, owner: nextOwner || `file:${path}` });
    }
    if (name === "MatchArm") {
      const literal = list.find((n) => n.name === "String");
      const method = literal && unquote(text(source, literal));
      if (method?.includes(".") && /core\/mod\.rs$/.test(path)) endpoints.push({ method, dispatch: "native", path, line: line(node.from), id: `native:${method}`, source: text(source, node).slice(0, 1200) });
    }
    const next = SCOPE.has(name) ? [...scopes, node] : scopes;
    for (const child of list) visit(child, next, nextOwner, nextProperties);
  }
  visit(tree.topNode, [], null, []);
  return { path, symbols, references: references.filter((r) => !defined.has(r.from)), imports, endpoints, errors, limited: visited > 60000, parser: description.name };
}

export function linkProject(units) {
  const paths = new Set(units.map((u) => u.path));
  const symbols = units.flatMap((u) => u.symbols || []), edges = [], endpoints = units.flatMap((u) => u.endpoints || []);
  const endpointMap = new Map(endpoints.filter((e) => e.accessor).map((e) => [e.accessor, e]));
  function resolveModule(path, name) {
    if (!name.startsWith(".")) return null;
    const out = path.split("/"); out.pop();
    for (const p of name.split("/")) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); }
    const base = out.join("/");
    return [base, ...[".js", ".ts", ".jsx", ".tsx", ".py", ".rs", "/index.js", "/index.ts"].map((s) => base + s)].find((p) => paths.has(p)) || null;
  }
  for (const unit of units) {
    const bindings = new Map();
    for (const imp of unit.imports || []) {
      const target = resolveModule(unit.path, imp.module);
      edges.push({ kind: "import", path: unit.path, line: imp.line, from: `file:${unit.path}`, to: target ? `file:${target}` : null, name: imp.module, confidence: target ? "resolved" : "external_or_unresolved" });
      if (target) {
        const named = imp.raw.match(/\{([^}]+)\}/)?.[1];
        if (named) for (const item of named.split(",")) { const [original, alias] = item.trim().split(/\s+as\s+/); if (original) bindings.set(alias || original, { target, original }); }
      }
    }
    for (const ref of unit.references || []) {
      const runtime = endpointMap.get(ref.name);
      if (runtime) { edges.push({ ...ref, from: ref.owner, to: runtime.id, confidence: "resolved" }); continue; }
      if (/[.:(\[]/.test(ref.name)) { if (ref.kind === "call" || ref.kind === "member") edges.push({ ...ref, from: ref.owner, to: null, confidence: "dynamic" }); continue; }
      let candidates = (unit.symbols || []).filter((s) => s.kind !== "property" && s.name === ref.name && s.scope_from <= ref.from && s.scope_to >= ref.from && !(unit.imports || []).some((imp) => imp.from <= s.from && s.from < imp.to));
      if (candidates.length) { const size = Math.min(...candidates.map((s) => s.scope_to - s.scope_from)); candidates = candidates.filter((s) => s.scope_to - s.scope_from === size); }
      if (!candidates.length && bindings.has(ref.name)) { const b = bindings.get(ref.name); candidates = symbols.filter((s) => s.path === b.target && s.name === b.original); }
      edges.push({ ...ref, from: ref.owner, to: candidates.length === 1 ? candidates[0].id : null, candidates: candidates.map((s) => s.id), confidence: candidates.length === 1 ? "lexical" : candidates.length ? "ambiguous" : "unresolved" });
    }
  }
  for (const endpoint of endpoints.filter((e) => e.accessor)) {
    symbols.push({ ...endpoint, name: endpoint.method, kind: "runtime", end_line: endpoint.line });
    for (const native of endpoints.filter((e) => e.dispatch === "native" && e.method === endpoint.method)) {
      symbols.push({ ...native, name: native.method, kind: "native_dispatch", end_line: native.line });
      edges.push({ kind: "dispatch", path: endpoint.path, line: endpoint.line, from: endpoint.id, to: native.id, confidence: "resolved", name: endpoint.method });
    }
    for (const bridge of symbols.filter((s) => s.name === `rpc_${endpoint.method.replaceAll(".", "_")}`)) edges.push({ kind: "dispatch", path: endpoint.path, line: endpoint.line, from: endpoint.id, to: bridge.id, confidence: "resolved", name: endpoint.method });
  }
  return { symbols, edges, coverage: { files: units.length, parsed: units.filter((u) => !u.unsupported).length, limited_files: units.filter((u) => u.limited).length, syntax_errors: units.reduce((n, u) => n + (u.errors || 0), 0), note: "基于语法树与静态绑定；动态调用、外部依赖和歧义保留为未解析。" } };
}
