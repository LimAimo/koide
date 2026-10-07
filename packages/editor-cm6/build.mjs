// 把 CodeMirror 6 适配器打包成浏览器能直接加载的 ES 模块。语言包按需拆成独立的小文件，只在打开对应语言的文件时才下载。
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const libDir = path.dirname(require.resolve("typescript"));
const libraries = Object.fromEntries(fs.readdirSync(libDir).filter((name) => /^lib\..*\.d\.ts$/.test(name)).map((name) => [name, fs.readFileSync(path.join(libDir, name), "utf8")]));
const localizedMessages = JSON.parse(fs.readFileSync(path.join(libDir, "zh-cn", "diagnosticMessages.generated.json"), "utf8"));

const outdir = fileURLToPath(new URL("../../apps/web/vendor", import.meta.url));
const options = {
  entryPoints: { cm6: fileURLToPath(new URL("./src/index.js", import.meta.url)), language: fileURLToPath(new URL("../../apps/web/src/services/language-worker.js", import.meta.url)) },
  platform: "browser",
  define: { process: "undefined" },
  plugins: [{ name: "语言标准库", setup(b) { b.onResolve({ filter: /^koide-ts-(libraries|localization)$/ }, (args) => ({ path: args.path, namespace: "koide" })); b.onLoad({ filter: /.*/, namespace: "koide" }, (args) => ({ contents: `export default ${JSON.stringify(args.path === "koide-ts-libraries" ? libraries : localizedMessages)}`, loader: "js" })); } }],
  outdir,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: ["chrome100", "firefox100", "safari15"],
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("监听中，修改 src/ 后会自动重新打包（Ctrl+C 退出）");
} else {
  await build(options);
  console.log(`已生成 ${outdir}/cm6.js`);
}
