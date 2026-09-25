// 极简终端屏幕：解析 ANSI 转义序列（颜色、光标移动、清行、回车覆盖），足够显示 shell、构建输出和进度条。
// 不支持全屏程序（vim、htop）。纯逻辑部分不依赖 DOM，可以在 Node 里测试。

const COLORS256 = (n) => {
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, lv = (x) => (x ? 55 + 40 * x : 0);
  return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
};
const EMPTY = Object.freeze({});

export class TermScreen {
  constructor(maxLines = 2000) {
    this.maxLines = maxLines;
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.style = EMPTY;
    this.mode = 0;       // 0 正常 1 ESC 2 CSI 3 OSC 4 字符集选择 5 OSC 结束
    this.buf = "";
  }

  write(text) { for (const ch of text) this._ch(ch); }

  _ch(c) {
    switch (this.mode) {
      case 1:
        if (c === "[") { this.mode = 2; this.buf = ""; } else if (c === "]") { this.mode = 3; } else if (c === "(" || c === ")") { this.mode = 4; } else this.mode = 0;
        return;
      case 2:
        if (c >= "@" && c <= "~") { this._csi(this.buf, c); this.mode = 0; } else this.buf += c;
        return;
      case 3: if (c === "\x07") this.mode = 0; else if (c === "\x1b") this.mode = 5; return;
      case 4: case 5: this.mode = 0; return;
      default:
    }
    if (c === "\x1b") { this.mode = 1; return; }
    if (c === "\n") return this._newline();
    if (c === "\r") { this.col = 0; return; }
    if (c === "\b") { this.col = Math.max(0, this.col - 1); return; }
    if (c === "\t") { const n = 8 - (this.col % 8); for (let i = 0; i < n; i++) this._put(" "); return; }
    if (c >= " " && c !== "\x7f") this._put(c);
  }

  _put(c) {
    const line = this.lines[this.row];
    while (line.length < this.col) line.push({ c: " ", s: EMPTY });
    line[this.col++] = { c, s: this.style };
  }

  _newline() {
    this.row++;
    while (this.row >= this.lines.length) this.lines.push([]);
    if (this.lines.length > this.maxLines) { this.lines.shift(); this.row--; }
  }

  _sgr(nums) {
    let s = { ...this.style };
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      if (n === 0) s = {};
      else if (n === 1) s.bold = true; else if (n === 22) delete s.bold;
      else if (n === 3) s.italic = true; else if (n === 23) delete s.italic;
      else if (n === 4) s.underline = true; else if (n === 24) delete s.underline;
      else if (n === 7) s.inverse = true; else if (n === 27) delete s.inverse;
      else if (n >= 30 && n <= 37) s.fg = n - 30;
      else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
      else if (n === 39) delete s.fg;
      else if (n >= 40 && n <= 47) s.bg = n - 40;
      else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
      else if (n === 49) delete s.bg;
      else if (n === 38 || n === 48) {
        const key = n === 38 ? "fg" : "bg";
        if (nums[i + 1] === 5) { const v = nums[i + 2]; s[key] = v < 16 ? v : COLORS256(v); i += 2; }
        else if (nums[i + 1] === 2) { s[key] = `rgb(${nums[i + 2]},${nums[i + 3]},${nums[i + 4]})`; i += 4; }
      }
    }
    this.style = Object.keys(s).length ? Object.freeze(s) : EMPTY;
  }

  _csi(params, final) {
    if (/^[?>]/.test(params)) return;                                  // 私有模式（如括号粘贴）忽略
    const nums = params.split(";").map((x) => (x === "" ? 0 : parseInt(x, 10) || 0));
    const n1 = nums[0] || 1, line = this.lines[this.row];
    switch (final) {
      case "m": this._sgr(nums.length ? nums : [0]); break;
      case "K":
        if ((nums[0] || 0) === 0) line.length = Math.min(line.length, this.col);
        else if (nums[0] === 1) for (let i = 0; i < Math.min(this.col + 1, line.length); i++) line[i] = { c: " ", s: EMPTY };
        else line.length = 0;
        break;
      case "J":
        if (nums[0] === 2 || nums[0] === 3) { this.lines = [[]]; this.row = 0; this.col = 0; }
        else if ((nums[0] || 0) === 0) { line.length = Math.min(line.length, this.col); this.lines.length = this.row + 1; }
        break;
      case "A": this.row = Math.max(0, this.row - n1); break;
      case "B": this.row += n1; while (this.row >= this.lines.length) this.lines.push([]); break;
      case "C": this.col += n1; break;
      case "D": this.col = Math.max(0, this.col - n1); break;
      case "G": this.col = Math.max(0, n1 - 1); break;
      case "H": case "f": this.col = Math.max(0, (nums[1] || 1) - 1); break;
      case "P": line.splice(this.col, n1); break;
      case "X": for (let i = 0; i < n1; i++) if (this.col + i < line.length) line[this.col + i] = { c: " ", s: EMPTY }; break;
      default:
    }
  }

  text() { return this.lines.map((l) => l.map((x) => x.c).join("").replace(/\s+$/, "")).join("\n"); }

  /** 把最后 maxLines 行画进 container（每次整体重画，行数受限所以很便宜）。 */
  render(container, maxLines = 400) {
    while (container.firstChild) container.removeChild(container.firstChild);
    const from = Math.max(0, this.lines.length - maxLines);
    for (let r = from; r < this.lines.length; r++) {
      const row = document.createElement("div");
      row.className = "tl-row";
      let run = null, runStyle = null;
      const flush = () => { if (run) { row.appendChild(run); run = null; } };
      for (const cell of this.lines[r]) {
        if (!run || cell.s !== runStyle) {
          flush();
          runStyle = cell.s;
          run = document.createElement("span");
          run.textContent = "";
          const s = cell.s;
          if (s !== EMPTY) {
            const cls = [];
            let fg = s.fg, bg = s.bg;
            if (s.inverse) [fg, bg] = [bg ?? "def", fg ?? "def"];
            if (typeof fg === "number") cls.push("tf" + fg); else if (fg === "def") cls.push("tinv-fg"); else if (fg) run.style.color = fg;
            if (typeof bg === "number") cls.push("tb" + bg); else if (bg === "def") cls.push("tinv-bg"); else if (bg) run.style.backgroundColor = bg;
            if (s.bold) cls.push("tbold"); if (s.italic) cls.push("titalic"); if (s.underline) cls.push("tunder");
            run.className = cls.join(" ");
          }
        }
        run.textContent += cell.c;
      }
      flush();
      if (!row.firstChild) row.appendChild(document.createTextNode("\u200b"));
      container.appendChild(row);
    }
  }
}
