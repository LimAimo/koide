// Animation Packs: declarative JSON only. A pack can restyle *how* code appears/moves/disappears; it can never
// execute code, and it can never change *what* corresponds to what (that is the engine's job).
//
// Pack shape:
//   { id, name, version: 1,
//     move|delete|insert|transform|groupMove: { duration, easing, stagger, drift?: {x:[min,max], y:[min,max]},
//                                               keyframes?: [ {opacity, filter, transform, color, textShadow, letterSpacing} ... ] } }
// Keyframe transforms may use {sx} {sy} (start position), {ex} {ey} (end position) and {rot} (random degrees).

export const KINDS = ["move", "delete", "insert", "transform", "groupMove"];
const ALLOWED_PROPS = new Set(["opacity", "filter", "transform", "color", "textShadow", "letterSpacing"]);
const FILTER_OK = /^(\s*(blur\(\d*\.?\d+px\)|brightness\(\d*\.?\d+\)|saturate\(\d*\.?\d+\))\s*)+$/;
const TRANSFORM_OK = /^(\s*(translate|scale|rotate|skewX)\(\s*[-\d.,\s{}a-z%]*\)\s*)+$/;
const COLOR_OK = /^(var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}|[a-z]+)$/;
const SHADOW_OK = /^[-\d.\spx,a-z#()%]*$/;

export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object") return ["动画包必须是一个对象"];
  if (!/^[a-z0-9-]{1,32}$/.test(pack.id || "")) errors.push("id 需为 1 到 32 位的小写字母、数字或短横线");
  if (pack.version !== 1) errors.push("不支持的版本号");
  for (const k of Object.keys(pack)) {
    if (["id", "name", "version", ...KINDS].includes(k)) continue;
    errors.push(`未知字段“${k}”`);
  }
  for (const kind of KINDS) {
    const spec = pack[kind];
    if (spec === undefined) continue;
    if (typeof spec !== "object") { errors.push(`${kind}：必须是对象`); continue; }
    for (const n of ["duration", "stagger"]) {
      if (spec[n] !== undefined && !(typeof spec[n] === "number" && spec[n] >= 0 && spec[n] <= 5000)) errors.push(`${kind}.${n}：取值范围为 0 到 5000`);
    }
    if (spec.easing !== undefined && !/^(linear|ease|ease-in|ease-out|ease-in-out|steps\(\d{1,2}\)|cubic-bezier\([-\d.,\s]+\))$/.test(spec.easing)) errors.push(`${kind}.easing 无效`);
    if (spec.drift) {
      for (const ax of ["x", "y"]) {
        const d = spec.drift[ax];
        if (!Array.isArray(d) || d.length !== 2 || d.some((v) => typeof v !== "number" || Math.abs(v) > 200)) errors.push(`${kind}.drift.${ax}：需为 [最小值, 最大值]，且在 ±200 以内`);
      }
    }
    if (spec.keyframes !== undefined) {
      if (!Array.isArray(spec.keyframes) || spec.keyframes.length < 2 || spec.keyframes.length > 8) { errors.push(`${kind}.keyframes：需要 2 到 8 帧`); continue; }
      spec.keyframes.forEach((f, i) => {
        if (!("transform" in f)) errors.push(`${kind}.keyframes[${i}]: 每一帧都需要 transform（它决定文字的位置）`);
        for (const [p, v] of Object.entries(f)) {
          const where = `${kind}.keyframes[${i}].${p}`;
          if (!ALLOWED_PROPS.has(p)) { errors.push(`${where}：不允许使用该属性`); continue; }
          if (p === "opacity") { if (typeof v !== "number" || v < 0 || v > 1) errors.push(`${where}：取值范围为 0 到 1`); }
          else if (typeof v !== "string") errors.push(`${where}：必须是字符串`);
          else if (p === "filter" && !FILTER_OK.test(v)) errors.push(`${where}：只允许 blur、brightness、saturate`);
          else if (p === "transform" && !TRANSFORM_OK.test(v)) errors.push(`${where}：只允许 translate、scale、rotate、skewX`);
          else if (p === "color" && !COLOR_OK.test(v)) errors.push(`${where}：颜色无效`);
          else if ((p === "textShadow" || p === "letterSpacing") && !SHADOW_OK.test(v)) errors.push(`${where}：无效`);
        }
      });
    }
  }
  return errors;
}

const moveDefault = { duration: 560, easing: "cubic-bezier(.2,.8,.2,1)", stagger: 220 };

export const BUILTIN_PACKS = {
  dissolve: {
    id: "dissolve", name: "溶解", version: 1,
    move: moveDefault,
    groupMove: { duration: 680, easing: "cubic-bezier(.2,.8,.2,1)", stagger: 160 },
    delete: { duration: 460, easing: "ease-in", stagger: 220, drift: { x: [-6, 8], y: [-16, -3] }, keyframes: [
      { opacity: 1, filter: "blur(0px)", transform: "translate({sx}px,{sy}px) scale(1)", textShadow: "0 0 7px var(--dfx-delete)" },
      { opacity: 0, filter: "blur(5px)", transform: "translate({ex}px,{ey}px) scale(.9)", textShadow: "0 0 0px transparent" }] },
    insert: { duration: 520, easing: "cubic-bezier(.05,.7,.1,1)", stagger: 280, drift: { x: [-4, 4], y: [4, 10] }, keyframes: [
      { opacity: 0, filter: "blur(5px)", transform: "translate({sx}px,{sy}px) scale(.94)", textShadow: "0 0 9px var(--dfx-insert)" },
      { opacity: 1, filter: "blur(0px)", transform: "translate({ex}px,{ey}px) scale(1)", textShadow: "0 0 0px transparent" }] },
    transform: { duration: 520, easing: "ease-in-out", stagger: 160 },
  },
  minimal: {
    id: "minimal", name: "极简", version: 1,
    move: { duration: 320, easing: "ease-out", stagger: 60 },
    groupMove: { duration: 380, easing: "ease-out", stagger: 40 },
    delete: { duration: 200, easing: "linear", stagger: 60, keyframes: [{ opacity: 1, transform: "translate({sx}px,{sy}px)" }, { opacity: 0, transform: "translate({ex}px,{ey}px)" }] },
    insert: { duration: 240, easing: "linear", stagger: 80, keyframes: [{ opacity: 0, transform: "translate({sx}px,{sy}px)" }, { opacity: 1, transform: "translate({ex}px,{ey}px)" }] },
    transform: { duration: 260, easing: "ease-in-out", stagger: 60 },
  },
  ash: {
    id: "ash", name: "灰烬", version: 1,
    move: { duration: 620, easing: "cubic-bezier(.3,.7,.2,1)", stagger: 260 },
    groupMove: { duration: 720, easing: "cubic-bezier(.3,.7,.2,1)", stagger: 200 },
    delete: { duration: 900, easing: "ease-out", stagger: 320, drift: { x: [4, 26], y: [-44, -14] }, keyframes: [
      { opacity: 1, filter: "brightness(1)", transform: "translate({sx}px,{sy}px) rotate(0deg)", textShadow: "0 0 6px var(--dfx-ash)" },
      { opacity: 0.6, filter: "brightness(.7) blur(1px)", transform: "translate({ex}px,{ey}px) rotate({rot}deg)" },
      { opacity: 0, filter: "brightness(.5) blur(3px)", transform: "translate({ex}px,{ey}px) rotate({rot}deg)" }] },
    insert: { duration: 620, easing: "cubic-bezier(.05,.7,.1,1)", stagger: 300, drift: { x: [0, 0], y: [10, 22] }, keyframes: [
      { opacity: 0, filter: "blur(3px)", transform: "translate({sx}px,{sy}px)" },
      { opacity: 1, filter: "blur(0px)", transform: "translate({ex}px,{ey}px)" }] },
    transform: { duration: 560, easing: "ease-in-out", stagger: 180 },
  },
  glitch: {
    id: "glitch", name: "故障", version: 1,
    move: { duration: 420, easing: "steps(6)", stagger: 160 },
    groupMove: { duration: 520, easing: "steps(8)", stagger: 120 },
    delete: { duration: 360, easing: "steps(5)", stagger: 160, drift: { x: [-10, 10], y: [-2, 2] }, keyframes: [
      { opacity: 1, transform: "translate({sx}px,{sy}px)", textShadow: "0 0 7px var(--dfx-delete)" },
      { opacity: 0.8, transform: "translate({ex}px,{sy}px) skewX(-12deg)" },
      { opacity: 0, transform: "translate({sx}px,{ey}px) skewX(10deg)" }] },
    insert: { duration: 420, easing: "steps(6)", stagger: 200, drift: { x: [-8, 8], y: [0, 0] }, keyframes: [
      { opacity: 0, transform: "translate({sx}px,{sy}px) skewX(12deg)", textShadow: "0 0 9px var(--dfx-insert)" },
      { opacity: 1, transform: "translate({ex}px,{ey}px) skewX(-6deg)" },
      { opacity: 1, transform: "translate({ex}px,{ey}px) skewX(0deg)" }] },
    transform: { duration: 400, easing: "steps(6)", stagger: 100 },
  },
};

for (const p of Object.values(BUILTIN_PACKS)) {
  const errs = validatePack(p);
  if (errs.length) throw new Error(`built-in pack ${p.id} invalid: ${errs.join("; ")}`);
}

const installed = new Map(Object.entries(BUILTIN_PACKS));

export function listPacks() { return [...installed.values()].map((p) => ({ id: p.id, name: p.name || p.id })); }
export function getPack(id) { return installed.get(id) || BUILTIN_PACKS.dissolve; }

/** Install a user pack. Throws with a readable message if it does not validate. */
export function installPack(pack) {
  const errs = validatePack(pack);
  if (errs.length) throw new Error(errs.slice(0, 4).join("; "));
  installed.set(pack.id, pack);
}

/** Load extra packs served by the Bridge (/animation-packs/index.json). Silently ignored when unavailable. */
export async function loadServedPacks(fetchFn = globalThis.fetch) {
  try {
    const idx = await (await fetchFn("/animation-packs/index.json")).json();
    for (const file of idx.packs || []) {
      try { installPack(await (await fetchFn(`/animation-packs/${encodeURIComponent(file)}`)).json()); } catch { /* skip bad pack */ }
    }
  } catch { /* offline or web-only mode */ }
}

/** Effective spec for a kind: chosen pack's spec, falling back to dissolve. */
export function specFor(packId, kind) {
  const pack = getPack(packId);
  if (pack[kind]) return pack[kind];
  if (kind === "groupMove" && pack.move) return pack.move;
  return BUILTIN_PACKS.dissolve[kind] || moveDefault;
}
