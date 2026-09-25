// 可选的 CodeMirror 6 编辑器。它由 `pnpm build:cm6` 打包到 apps/web/vendor/cm6.js；没有构建时返回 null，界面继续使用内置编辑器。

let cached = null;

export function loadCM6() {
  if (!cached) cached = import("/vendor/cm6.js").then((m) => m.createCM6Editor).catch(() => null);
  return cached;
}
