#!/usr/bin/env node
import fs from "node:fs";

const runtimePath = "apps/web/src/services/runtime/index.js";
const nativePath = "apps/native/src-tauri/src/core/mod.rs";
const runtime = fs.readFileSync(runtimePath, "utf8");
const native = fs.readFileSync(nativePath, "utf8");

const runtimeMethods = [...new Set([...runtime.matchAll(/call\("([^"]+)"/g)].map(m => m[1]))].sort();
const nativeMethods = new Set([...native.matchAll(/"([^"]+)"\s*=>/g)].map(m => m[1]));
const missing = runtimeMethods.filter(method => !nativeMethods.has(method));

console.log(`Runtime API methods: ${runtimeMethods.length}`);
console.log(`Native dispatch coverage: ${runtimeMethods.length - missing.length}/${runtimeMethods.length}`);

if (missing.length) {
  console.error("Native Core is missing Runtime API methods:");
  for (const method of missing) console.error(`  - ${method}`);
  process.exit(1);
}

if (!native.includes('"python_bridge_removal_allowed": false')) {
  console.error("Parity gate must remain locked until semantic blockers are explicitly cleared.");
  process.exit(1);
}

console.log("Dispatch parity gate passed; semantic Python-removal gate remains locked.");
