// Structure analysis used by the Diffusion Engine.
//
// NOTE: this is a *heuristic* structure provider (indentation + closing-bracket based). It is deliberately
// behind a tiny interface -- segmentBlocks(lines) -- so a real AST provider (tree-sitter) can replace it
// later without touching the matching code.

const TOKEN_RE = /[A-Za-z_$][\w$]*|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|[\p{L}\p{N}_]+|[-+*/%=&|<>!^~?:.]{2,3}|\S/gu;

export function splitLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function isBlank(line) {
  return line.trim() === "";
}

export function leadingWs(line) {
  return line.length - line.trimStart().length;
}

/** Non-whitespace tokens with their string column. */
export function tokenize(line) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(line)) !== null) out.push({ text: m[0], col: m.index });
  return out;
}

const CLOSER = /^([}\])]|end\b|fi\b|done\b|esac\b|<\/)/;

/**
 * Split lines[start,end) into top-level blocks: a header line plus everything indented deeper (blank lines
 * inside included) plus a trailing closer line at the header's indent. Returns [{start, end}] (end exclusive).
 */
export function segmentBlocks(lines, start = 0, end = lines.length) {
  const blocks = [];
  let i = start;
  while (i < end) {
    if (isBlank(lines[i])) { i++; continue; }
    const base = leadingWs(lines[i]);
    let j = i + 1;
    while (j < end) {
      const l = lines[j];
      if (isBlank(l)) {
        let k = j + 1;
        while (k < end && isBlank(lines[k])) k++;
        if (k < end && leadingWs(lines[k]) > base) { j = k; continue; }
        break;
      }
      const ind = leadingWs(l);
      if (ind > base) { j++; continue; }
      if (ind === base && CLOSER.test(l.trim())) { j++; }
      break;
    }
    blocks.push({ start: i, end: j });
    i = j;
  }
  return blocks;
}

/** Text of a block with its common indentation removed, so a block moved to another nesting still matches. */
export function dedentedKey(lines, b) {
  const slice = lines.slice(b.start, b.end);
  let min = Infinity;
  for (const l of slice) if (!isBlank(l)) min = Math.min(min, leadingWs(l));
  if (!isFinite(min)) min = 0;
  return slice.map((l) => (isBlank(l) ? "" : l.slice(min).trimEnd())).join("\n");
}
