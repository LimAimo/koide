// 输入方式与可用宽度共同决定布局；物理屏幕短边避免软键盘把平板误判成手机。
export function viewportMode({ width = globalThis.innerWidth || globalThis.window?.innerWidth || 0, height = globalThis.innerHeight || globalThis.window?.innerHeight || 0, coarse = !!globalThis.matchMedia?.("(pointer: coarse)")?.matches, shortSide = Math.min(globalThis.screen?.width || width, globalThis.screen?.height || height) } = {}) {
  if (width < 600 || (coarse && shortSide > 0 && shortSide < 600)) return "phone";
  if (width < 900 || coarse) return "tablet";
  return "desktop";
}

export function surfaceSide(anchor, fallback = "right") {
  const element = anchor?.currentTarget || anchor;
  const declared = element?.closest?.("[data-surface-side]")?.dataset?.surfaceSide;
  if (declared === "left" || declared === "right") return declared;
  const rect = element?.getBoundingClientRect?.();
  const width = globalThis.innerWidth || globalThis.window?.innerWidth || 0;
  if (rect && rect.width > 0 && width) return rect.left + rect.width / 2 < width / 2 ? "left" : "right";
  return fallback;
}
