// 把 CodeMirror 6 适配器打包成浏览器能直接加载的 ES 模块。语言包按需拆成独立的小文件，只在打开对应语言的文件时才下载。
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";

const outdir = fileURLToPath(new URL("../../apps/web/vendor", import.meta.url));
const options = {
  entryPoints: { cm6: fileURLToPath(new URL("./src/index.js", import.meta.url)) },
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
