import ts from "typescript";
import libraries from "koide-ts-libraries";
import localizedMessages from "koide-ts-localization";
ts.setLocalizedDiagnosticMessages(localizedMessages);

// 完全在内存中的真正 TypeScript LanguageService：不拥有文件系统或 IPC 能力。
export function analyze(request) {
  const files = new Map((request.files || []).map((f) => [`/project/${f.path.replaceAll("\\", "/")}`, f]));
  if (files.size > 1000 || [...files.values()].reduce((n, f) => n + f.content.length, 0) > 12 * 1024 * 1024) throw new Error("语言分析超过 1000 个文件或 12 MiB，请缩小项目范围");
  const options = { allowJs: true, checkJs: true, noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true };
  const contents = (name) => files.get(name)?.content ?? libraries[name.replace(/^\/lib\//, "")];
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (name) => files.get(name)?.revision || "1",
    getScriptSnapshot: (name) => { const text = contents(name); return text == null ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => "/project", getDefaultLibFileName: () => "/lib/lib.es2022.full.d.ts",
    fileExists: (name) => contents(name) != null, readFile: contents, readDirectory: () => [...files.keys()],
    directoryExists: (name) => [...files.keys()].some((p) => p.startsWith(`${name}/`)) || name === "/lib",
    getDirectories: () => [], useCaseSensitiveFileNames: () => true,
  };
  const service = ts.createLanguageService(host), path = `/project/${request.path || ""}`, position = Number(request.position) || 0;
  const location = (x) => { const f = service.getProgram()?.getSourceFile(x.fileName); const offset = x.textSpan?.start || 0; const line = f ? ts.getLineAndCharacterOfPosition(f, offset).line + 1 : 1; return { path: x.fileName.replace(/^\/project\//, ""), offset, length: x.textSpan?.length || 0, line }; };
  try {
    if (request.operation === "diagnostics") {
      const issues = [];
      for (const name of files.keys()) for (const d of [...service.getSyntacticDiagnostics(name), ...service.getSemanticDiagnostics(name)]) {
        const line = d.file ? ts.getLineAndCharacterOfPosition(d.file, d.start || 0).line + 1 : 1;
        issues.push({ source: "typescript", path: name.slice(9), offset: d.start || 0, line, severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning", code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") });
      }
      return { issues };
    }
    if (!files.has(path)) throw new Error("当前文件不在 JS / TS 分析范围内");
    if (request.operation === "definition") return { locations: (service.getDefinitionAtPosition(path, position) || []).filter((x) => files.has(x.fileName)).map(location) };
    if (request.operation === "references") return { locations: (service.getReferencesAtPosition(path, position) || []).filter((x) => files.has(x.fileName)).map(location) };
    if (request.operation === "rename") {
      if (!request.new_name || !ts.isIdentifierText(request.new_name, ts.ScriptTarget.ES2022) || (ts.stringToToken(request.new_name) ?? 0) >= ts.SyntaxKind.FirstKeyword) throw new Error("新名称必须是合法标识符，不能使用保留关键字");
      const info = service.getRenameInfo(path, position, { allowRenameOfImportPath: false });
      if (!info.canRename) throw new Error(info.localizedErrorMessage || "当前位置不能重命名");
      const changes = new Map();
      for (const x of service.findRenameLocations(path, position, false, false, true) || []) {
        if (!files.has(x.fileName)) throw new Error("重命名涉及分析范围之外的文件，请扩大范围");
        const target = changes.get(x.fileName) || [];
        target.push({ from: x.textSpan.start, to: x.textSpan.start + x.textSpan.length, insert: `${x.prefixText || ""}${request.new_name}${x.suffixText || ""}` }); changes.set(x.fileName, target);
      }
      return { files: [...changes].map(([name, edits]) => ({ path: name.slice(9), revision: files.get(name).revision, edits: edits.sort((a, b) => b.from - a.from) })) };
    }
    throw new Error("未知的语言服务操作");
  } finally { service.dispose(); }
}
if (typeof self !== "undefined" && typeof document === "undefined") self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, result: analyze(data) }); }
  catch (e) { self.postMessage({ id: data.id, error: e.message }); }
};
