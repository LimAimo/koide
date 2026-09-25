import test from "node:test";
import assert from "node:assert/strict";
import { encodeQR, rsRemainder, formatBits } from "../../apps/web/src/services/qr.js";
import { parsePairHash } from "../../apps/web/src/services/pairing.js";

// ---- 独立的「解码器」：只依赖规范里的布局规则，用来验证生成器没有做错 ----------------------------------------------------
const EXP = new Uint8Array(512);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const LOGT = new Uint8Array(256); for (let i = 0; i < 255; i++) LOGT[EXP[i]] = i;
const gmul = (a, b) => (a && b ? EXP[LOGT[a] + LOGT[b]] : 0);

const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0];

function decode(m) {
  const size = m.length, ver = (size - 17) / 4, bit = (x, y) => (m[y][x] ? 1 : 0);
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) isFn[y][x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8);            // 三个定位图案 + 分隔 + 格式信息
  for (let i = 0; i < size; i++) { isFn[6][i] = true; isFn[i][6] = true; }
  if (ver >= 2) { const c = { 2: 18, 3: 22, 4: 26, 5: 30 }[ver]; mark(c - 2, c - 2, 5, 5); }
  // 格式信息：读第一份，并检查第二份完全一致
  const pos1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let f1 = 0, f2 = 0;
  pos1.forEach(([x, y], i) => { f1 |= bit(x, y) << i; });
  for (let i = 0; i < 8; i++) f2 |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= bit(8, size - 15 + i) << i;
  assert.equal(f1, f2, "两份格式信息必须一致");
  const f = f1 ^ 0x5412, mask = (f >> 10) & 7, ecc = (f >> 13) & 3;
  assert.equal(ecc, 1, "纠错等级应为 L");
  assert.equal(f1, formatBits(mask), "格式信息必须是合法的 BCH 码字");
  // 读数据位
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!isFn[y][x]) bits.push(bit(x, y) ^ (MASK[mask](x, y) ? 1 : 0));
    }
  }
  const total = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134 }[ver], cw = [];
  for (let i = 0; i < total; i++) cw.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2));
  const ecCount = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26 }[ver];
  for (let r = 0; r < ecCount; r++) {                                            // 校验：码字多项式在 α^0..α^(n-1) 处的值必须为 0
    let s = 0; for (const c of cw) s = gmul(s, EXP[r]) ^ c;
    assert.equal(s, 0, "纠错校验必须通过");
  }
  const stream = cw.slice(0, total - ecCount).flatMap((c) => [...c.toString(2).padStart(8, "0")].map(Number));
  const take = (n) => parseInt(stream.splice(0, n).join(""), 2);
  assert.equal(take(4), 0b0100, "应为字节模式");
  const len = take(8), out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return new TextDecoder().decode(new Uint8Array(out));
}

test("Reed-Solomon：已知的标准示例（HELLO WORLD，1-Q）", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
  assert.deepEqual(rsRemainder(data, 13), [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
});

test("Reed-Solomon：任意数据的码字多项式都能被生成多项式整除", () => {
  for (const deg of [7, 10, 15, 20, 26]) {
    const data = Array.from({ length: 30 }, (_, i) => (i * 37 + deg) & 255);
    const cw = data.concat(rsRemainder(data, deg));
    for (let r = 0; r < deg; r++) { let s = 0; for (const c of cw) s = gmul(s, EXP[r]) ^ c; assert.equal(s, 0); }
  }
});

test("格式信息与规范里的已知值一致（L 级，掩码 0 到 3）", () => {
  assert.equal(formatBits(0), 0b111011111000100);
  assert.equal(formatBits(1), 0b111001011110011);
  assert.equal(formatBits(2), 0b111110110101010);
  assert.equal(formatBits(3), 0b111100010011101);
});

test("二维码：结构正确，并且能用独立解码器还原出原文", () => {
  const cases = ["1", "hello", "http://192.168.1.20:8765/#pair=123456", "http://192.168.100.200:8765/#pair=987654", "配对：你好，世界", "x".repeat(100)];
  const seen = new Set();
  for (const text of cases) {
    const { size, modules, version } = encodeQR(text);
    seen.add(version);
    assert.equal(size, 17 + 4 * version);
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {                       // 三个定位图案：外框黑、次外圈白、中心 3x3 黑
      for (let d = 0; d < 7; d++) assert.ok(modules[oy][ox + d] && modules[oy + 6][ox + d] && modules[oy + d][ox] && modules[oy + d][ox + 6]);
      assert.ok(modules[oy + 3][ox + 3] && !modules[oy + 1][ox + 1] && modules[oy + 2][ox + 2]);
    }
    for (let i = 8; i < size - 8; i++) assert.equal(modules[6][i], i % 2 === 0);              // 定位线交替
    assert.ok(modules[size - 8][8], "固定黑块");
    assert.equal(decode(modules), text, "还原的文本必须和原文一致：" + text);
  }
  assert.ok(seen.size >= 4, "覆盖了多个版本：" + [...seen]);
});

test("内容太长会报错，而不是生成坏码", () => {
  assert.throws(() => encodeQR("x".repeat(107)), /太长/);
});

test("配对链接解析", () => {
  assert.equal(parsePairHash("#pair=123456"), "123456");
  assert.equal(parsePairHash("#a=1&pair=654321"), "654321");
  assert.equal(parsePairHash("#pair=12345"), null);
  assert.equal(parsePairHash(""), null);
  assert.equal(parsePairHash(undefined), null);
});
