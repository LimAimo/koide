// 二维码生成器（纯 JS，无依赖）：字节模式、纠错等级 L、版本 1–5、单数据块，最多容纳 106 字节，足够放一个配对链接。
// 主要用来在电脑上显示「扫码配对」二维码。渲染时总是白底黑块，保证任何主题下手机都能扫。

const EC = { 1: [19, 7], 2: [34, 10], 3: [55, 15], 4: [80, 20], 5: [108, 26] };   // [数据码字数, 纠错码字数]
const ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30 };                                      // 对齐图案中心坐标

// ---- GF(256) 与 Reed-Solomon ----------------------------------------------------------------------------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

export function rsRemainder(data, deg) {
  let gen = [1];
  for (let i = 0; i < deg; i++) {
    const ng = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { ng[j] ^= gen[j]; ng[j + 1] ^= mul(gen[j], EXP[i]); }
    gen = ng;
  }
  const res = new Array(deg).fill(0);
  for (const b of data) {
    const f = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < deg; i++) res[i] ^= mul(gen[i + 1], f);
  }
  return res;
}

/** 格式信息（纠错等级 L + 掩码编号），15 位，已异或 0x5412。 */
export function formatBits(mask) {
  const data = (1 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

function penalty(m) {
  const n = m.length;
  let p = 0, dark = 0;
  for (let pass = 0; pass < 2; pass++) {                              // 行、列里连续 5 个以上同色
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass ? m[b][a] : m[a][b], prev = pass ? m[b - 1][a] : m[a][b - 1];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  for (const row of m) for (const v of row) if (v) dark++;
  p += (Math.ceil(Math.abs((dark * 20) / (n * n) - 10)) - 1) * 10;
  return p;
}

/** 返回 { version, size, modules }，modules[y][x] 为 true 表示黑块。内容太长会抛出错误。 */
export function encodeQR(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 5; v++) if (bytes.length <= EC[v][0] - 2) { version = v; break; }
  if (!version) throw new Error("内容太长，二维码最多容纳 106 字节");
  const [dataCw, ecCw] = EC[version];

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const cap = dataCw * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const codewords = data.concat(rsRemainder(data, ecCw));

  const size = 17 + 4 * version;
  const base = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { base[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }                 // 定位线
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);                                                 // 三个定位图案
  if (version >= 2) { const c = ALIGN[version]; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
  const drawFormat = (m, mask) => {
    const bitsF = formatBits(mask), get = (i) => ((bitsF >>> i) & 1) !== 0;
    const set = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };
    for (let i = 0; i <= 5; i++) set(8, i, get(i));
    set(8, 7, get(6)); set(8, 8, get(7)); set(7, 8, get(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, get(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, get(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, get(i));
    set(8, size - 8, true);                                                                                // 固定的黑块
  };
  drawFormat(base, 0);

  let i = 0;                                                                                               // 蛇形放置数据位
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) { base[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }
  }

  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((r) => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    drawFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return { version, size, modules: best };
}

/** 生成白底黑块的 SVG 元素（含 4 格静区）。 */
export function qrSvg(text, { scale = 6, quiet = 4 } = {}) {
  const { size, modules } = encodeQR(text);
  const total = size + quiet * 2, NS = "http://www.w3.org/2000/svg";
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size;) {
      if (!modules[y][x]) { x++; continue; }
      let w = 1;
      while (x + w < size && modules[y][x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w;
    }
  }
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("width", String(total * scale));
  svg.setAttribute("height", String(total * scale));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "配对二维码");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(total)); bg.setAttribute("height", String(total)); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}
