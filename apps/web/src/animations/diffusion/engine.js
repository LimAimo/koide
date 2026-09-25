// Diffusion Engine: turns (before, after) into a *plan* of atoms describing how code flows from one state to
// the next. It never trusts an AI's stated intent; it only analyses the real before/after text.
//
// Levels (highest first, degrade when unsure):
//   1. Block  - whole structural blocks that moved intact           -> GROUP_MOVE
//   2. Line   - order-preserving matches, moved lines, similar lines -> KEEP / LAYOUT_SHIFT / MOVE / TRANSFORM
//   3. Token  - inside similar lines                                  -> KEEP / LAYOUT_SHIFT / TRANSFORM / DELETE / INSERT
//   4. Plain  - if analysis is unreliable or too big: 'simplified' (renderer cross-fades the whole text)
//
// Principle: better a simple animation than a wrong match. Low-confidence moves are never emitted; they
// degrade to DELETE + INSERT.

import { splitLines, isBlank, leadingWs, tokenize, segmentBlocks, dedentedKey } from "./structure.js";

export const KIND = {
  KEEP: "KEEP", MOVE: "MOVE", TRANSFORM: "TRANSFORM", DELETE: "DELETE", INSERT: "INSERT",
  GROUP_MOVE: "GROUP_MOVE", LAYOUT_SHIFT: "LAYOUT_SHIFT",
};

export const DEFAULTS = {
  minMoveConfidence: 0.7,      // below this a "move" becomes delete + insert
  minTransformSimilarity: 0.5, // below this two lines/tokens are not considered the same thing
  minBlockLines: 2,
  tokenLines: 40,              // <= this many changed lines -> token granularity
  lineLines: 300,              // <= this many -> line granularity, more -> simplified
  maxLines: 6000,
  lcsLimit: 2_500_000,         // n*m cells; beyond this the analysis is considered unreliable
};

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
/** Longest common subsequence pairs [[i,j],...]; null when the problem is too large to solve cheaply. */
export function lcsPairs(a, b, limit = DEFAULTS.lcsLimit) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  const pairs = [];
  for (let i = 0; i < s; i++) pairs.push([i, i]);
  if (n > 0 && m > 0) {
    if (n * m > limit) return null;
    const w = m + 1;
    const t = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[s + i] === b[s + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[s + i] === b[s + j]) { pairs.push([s + i, s + j]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < a.length - ea; k++) pairs.push([ea + k, eb + k]);
  return pairs;
}

/** Longest increasing subsequence of `seq` (numbers); returns the set of kept indices. O(n^2), n is tiny. */
function lisIndices(seq) {
  const n = seq.length;
  const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = n ? best : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

function dice(aTexts, bTexts) {
  if (!aTexts.length && !bTexts.length) return 1;
  const counts = new Map();
  for (const t of aTexts) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of bTexts) {
    const c = counts.get(t);
    if (c) { common++; counts.set(t, c - 1); }
  }
  return (2 * common) / (aTexts.length + bTexts.length);
}

/** 1 - levenshtein/maxLen for short strings (tokens). */
export function stringSimilarity(a, b) {
  if (a === b) return 1;
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

/** Monotonic best alignment of two lists by similarity. Pairs below minSim are never made. */
function alignBySimilarity(aItems, bItems, sim, minSim) {
  const n = aItems.length, m = bItems.length;
  if (!n || !m) return [];
  const s = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => sim(aItems[i], bItems[j])));
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const v = s[i - 1][j - 1];
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], v >= minSim ? dp[i - 1][j - 1] + v : -1);
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const v = s[i - 1][j - 1];
    if (v >= minSim && Math.abs(dp[i][j] - (dp[i - 1][j - 1] + v)) < 1e-9) { out.push([i - 1, j - 1, v]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return out.reverse();
}

const significant = (key) => key.length >= 4 && /[\p{L}\p{N}]/u.test(key);

// ---------------------------------------------------------------------------------------------
// Line-level correspondence
// ---------------------------------------------------------------------------------------------
function correspond(bl, al, o) {
  const pairs = [];                 // {o, n, kind, conf, exact, group}
  const usedO = new Set(), usedN = new Set();
  let groupSeq = 0;

  // ---- Level 1: blocks that survived intact ----------------------------------------------------
  const ob = segmentBlocks(bl).filter((b) => b.end - b.start >= o.minBlockLines);
  const nb = segmentBlocks(al).filter((b) => b.end - b.start >= o.minBlockLines);
  if (ob.length && nb.length) {
    const okeys = ob.map((b) => dedentedKey(bl, b)), nkeys = nb.map((b) => dedentedKey(al, b));
    const cntO = new Map(), cntN = new Map();
    okeys.forEach((k) => cntO.set(k, (cntO.get(k) || 0) + 1));
    nkeys.forEach((k) => cntN.set(k, (cntN.get(k) || 0) + 1));
    const bucket = new Map();
    okeys.forEach((k, i) => { if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(i); });
    const matches = [];
    nkeys.forEach((k, j) => { const l = bucket.get(k); if (l && l.length) matches.push([l.shift(), j]); });
    matches.sort((x, y) => x[0] - y[0]);
    const inOrder = lisIndices(matches.map((m) => m[1]));
    matches.forEach(([bi, bj], idx) => {
      const A = ob[bi], B = nb[bj];
      const moved = !inOrder.has(idx);
      const unique = cntO.get(okeys[bi]) === 1 && cntN.get(nkeys[bj]) === 1;
      const conf = unique ? 0.98 : 0.6;
      if (moved && conf < o.minMoveConfidence) return;       // too ambiguous: leave to line level
      const group = ++groupSeq;
      for (let k = 0; k < A.end - A.start; k++) {
        const oi = A.start + k, ni = B.start + k;
        usedO.add(oi); usedN.add(ni);
        if (isBlank(bl[oi])) continue;
        pairs.push({ o: oi, n: ni, exact: true, conf: unique ? 0.98 : 0.9, group, via: "block",
          kind: moved ? KIND.GROUP_MOVE : null });
      }
    });
  }

  // ---- Level 2a: order-preserving line matches --------------------------------------------------
  const remO = [], remN = [];
  bl.forEach((l, i) => { if (!usedO.has(i) && !isBlank(l)) remO.push(i); });
  al.forEach((l, i) => { if (!usedN.has(i) && !isBlank(l)) remN.push(i); });
  const lc = lcsPairs(remO.map((i) => bl[i].trim()), remN.map((i) => al[i].trim()), o.lcsLimit);
  if (lc === null) return null;
  const anchorPairs = lc.map(([a, b]) => ({ o: remO[a], n: remN[b], exact: true, conf: 1, via: "lcs", kind: null }));
  const aO = new Map(anchorPairs.map((p) => [p.o, p])), aN = new Map(anchorPairs.map((p) => [p.n, p]));
  pairs.push(...anchorPairs);
  const unO = new Set(remO.filter((i) => !aO.has(i))), unN = new Set(remN.filter((i) => !aN.has(i)));

  // ---- Level 2b: moved lines (identical text, different order) ------------------------------------
  const cO = new Map(), cN = new Map(), listN = new Map();
  for (const i of unO) cO.set(bl[i].trim(), (cO.get(bl[i].trim()) || 0) + 1);
  for (const i of [...unN].sort((a, b) => a - b)) {
    const k = al[i].trim();
    cN.set(k, (cN.get(k) || 0) + 1);
    if (!listN.has(k)) listN.set(k, []);
    listN.get(k).push(i);
  }
  const moves = [], movedO = new Set(), movedN = new Set();
  for (const oi of [...unO].sort((a, b) => a - b)) {
    const k = bl[oi].trim();
    if (!significant(k)) continue;
    const l = listN.get(k);
    if (!l || !l.length) continue;
    const conf = cO.get(k) === 1 && cN.get(k) === 1 ? 0.92 : 0.6;
    if (conf < o.minMoveConfidence) continue;
    const ni = l.shift();
    moves.push({ o: oi, n: ni, conf });
    movedO.add(oi); movedN.add(ni);
  }

  // group consecutive moved lines, then grow each group over identical neighbours ("}" and friends)
  moves.sort((a, b) => a.o - b.o);
  const groups = [];
  for (const m of moves) {
    const g = groups[groups.length - 1];
    if (g && m.o === g.oEnd + 1 && m.n === g.nEnd + 1) { g.oEnd++; g.nEnd++; g.conf = Math.min(g.conf, m.conf); }
    else groups.push({ oStart: m.o, oEnd: m.o, nStart: m.n, nEnd: m.n, conf: m.conf });
  }
  // A neighbour may be free, or LCS-anchored on a non-distinctive line such as "}". In the latter case its
  // partner is swapped out: all lines involved have identical text, so re-pairing is always valid.
  const stateO = (i) => (i < 0 || i >= bl.length || isBlank(bl[i]) || usedO.has(i) || movedO.has(i) ? "no" : aO.has(i) ? "anch" : unO.has(i) ? "free" : "no");
  const stateN = (i) => (i < 0 || i >= al.length || isBlank(al[i]) || usedN.has(i) || movedN.has(i) ? "no" : aN.has(i) ? "anch" : unN.has(i) ? "free" : "no");
  const claimO = (i) => { const p = aO.get(i); if (p) { p.dead = true; aO.delete(i); aN.delete(p.n); unN.add(p.n); } else unO.delete(i); movedO.add(i); };
  const claimN = (i) => { const p = aN.get(i); if (p) { p.dead = true; aN.delete(i); aO.delete(p.o); unO.add(p.o); } else unN.delete(i); movedN.add(i); };
  const canJoin = (a, b) => {
    const sa = stateO(a), sb = stateN(b);
    if (sa === "no" || sb === "no" || bl[a].trim() !== al[b].trim()) return false;
    if (sa === "free" && sb === "free") return true;
    return !significant(bl[a].trim()) && !(aO.get(a) && aO.get(a).n === b);
  };
  for (const g of groups) {
    while (canJoin(g.oEnd + 1, g.nEnd + 1)) { g.oEnd++; g.nEnd++; claimO(g.oEnd); claimN(g.nEnd); }
    while (canJoin(g.oStart - 1, g.nStart - 1)) { g.oStart--; g.nStart--; claimO(g.oStart); claimN(g.nStart); }
    const size = g.oEnd - g.oStart + 1, id = ++groupSeq;
    for (let k = 0; k < size; k++) {
      pairs.push({ o: g.oStart + k, n: g.nStart + k, exact: true, conf: g.conf, group: size > 1 ? id : undefined,
        via: "move", kind: size > 1 ? KIND.GROUP_MOVE : KIND.MOVE });
    }
  }
  for (let k = pairs.length - 1; k >= 0; k--) if (pairs[k].dead) pairs.splice(k, 1);
  for (const i of movedO) unO.delete(i);
  for (const i of movedN) unN.delete(i);

  // ---- Level 2c: similar lines between the same anchors (modified lines) -----------------------------
  const anchSorted = pairs.filter((p) => p.via === "lcs").map((p) => [p.o, p.n]).sort((a, b) => a[0] - b[0]);
  const gapOf = (idx, side) => {
    let g = 0;
    while (g < anchSorted.length && anchSorted[g][side] < idx) g++;
    return g;
  };
  const gapsO = new Map(), gapsN = new Map();
  for (const i of [...unO].sort((a, b) => a - b)) { const g = gapOf(i, 0); (gapsO.get(g) || gapsO.set(g, []).get(g)).push(i); }
  for (const i of [...unN].sort((a, b) => a - b)) { const g = gapOf(i, 1); (gapsN.get(g) || gapsN.set(g, []).get(g)).push(i); }
  const tokCache = new Map();
  const toks = (lines, i, tag) => {
    const key = tag + i;
    if (!tokCache.has(key)) tokCache.set(key, tokenize(lines[i]).map((t) => t.text));
    return tokCache.get(key);
  };
  const deletes = new Set(unO), inserts = new Set(unN);
  for (const [g, olist] of gapsO) {
    const nlist = gapsN.get(g);
    if (!nlist) continue;
    const al2 = alignBySimilarity(olist, nlist, (x, y) => dice(toks(bl, x, "o"), toks(al, y, "n")), o.minTransformSimilarity);
    for (const [a, b, sim] of al2) {
      pairs.push({ o: olist[a], n: nlist[b], exact: false, conf: sim, via: "similar", kind: KIND.TRANSFORM });
      deletes.delete(olist[a]); inserts.delete(nlist[b]);
    }
  }
  return { pairs, deletes: [...deletes].sort((a, b) => a - b), inserts: [...inserts].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------------------------
// Atom emission
// ---------------------------------------------------------------------------------------------
class Emitter {
  constructor(bl, al) { this.bl = bl; this.al = al; this.atoms = []; this.id = 0; }
  push(a) { a.id = ++this.id; this.atoms.push(a); return a; }

  lineAtom(kind, oi, ni, conf, group, extra = {}) {
    const lo = oi != null ? this.bl[oi] : null, ln = ni != null ? this.al[ni] : null;
    const a = { kind, conf, group, level: "line", ...extra };
    if (ln != null) { a.text = ln.trim(); a.to = { line: ni, col: leadingWs(ln) }; }
    if (lo != null) { a.from = { line: oi, col: leadingWs(lo) }; if (ln == null) a.text = lo.trim(); else a.fromText = lo.trim(); }
    return this.push(a);
  }

  tokenAtoms(kind, lines, li, side, conf) {
    for (const t of tokenize(lines[li])) {
      const pos = { line: li, col: t.col };
      this.push({ kind, text: t.text, conf, level: "token", [side]: pos });
    }
  }

  /** Token-level diff inside a pair of similar lines. */
  tokenPair(oi, ni, conf, o) {
    const A = tokenize(this.bl[oi]), B = tokenize(this.al[ni]);
    const lc = lcsPairs(A.map((t) => t.text), B.map((t) => t.text), o.lcsLimit) || [];
    let pa = 0, pb = 0;
    const flush = (ea, eb) => {
      const runA = A.slice(pa, ea), runB = B.slice(pb, eb);
      const paired = alignBySimilarity(runA, runB, (x, y) => stringSimilarity(x.text, y.text), o.minTransformSimilarity);
      const doneA = new Set(), doneB = new Set();
      let list = paired;
      if (!list.length && runA.length && runA.length === runB.length) list = runA.map((_, k) => [k, k, 0.6]);
      for (const [a, b, sim] of list) {
        doneA.add(a); doneB.add(b);
        this.push({ kind: KIND.TRANSFORM, text: runB[b].text, fromText: runA[a].text, level: "token",
          from: { line: oi, col: runA[a].col }, to: { line: ni, col: runB[b].col }, conf: Math.min(conf, sim) });
      }
      runA.forEach((t, k) => { if (!doneA.has(k)) this.push({ kind: KIND.DELETE, text: t.text, level: "token", conf, from: { line: oi, col: t.col } }); });
      runB.forEach((t, k) => { if (!doneB.has(k)) this.push({ kind: KIND.INSERT, text: t.text, level: "token", conf, to: { line: ni, col: t.col } }); });
    };
    for (const [ia, ib] of lc) {
      flush(ia, ib);
      const same = oi === ni && A[ia].col === B[ib].col;
      this.push({ kind: same ? KIND.KEEP : KIND.LAYOUT_SHIFT, text: B[ib].text, level: "token", conf,
        from: { line: oi, col: A[ia].col }, to: { line: ni, col: B[ib].col } });
      pa = ia + 1; pb = ib + 1;
    }
    flush(A.length, B.length);
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
function simplifiedPlan(bl, al, reason) {
  return { changed: true, granularity: "simplified", reason, atoms: [], stats: {}, beforeLines: bl.length, afterLines: al.length };
}

export function analyze(before, after, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const bl = splitLines(before), al = splitLines(after);
  if (before === after) return { changed: false, granularity: "none", atoms: [], stats: {}, beforeLines: bl.length, afterLines: al.length };
  if (bl.length > o.maxLines || al.length > o.maxLines) return simplifiedPlan(bl, al, "document too large");

  const corr = correspond(bl, al, o);
  if (!corr) return simplifiedPlan(bl, al, "analysis too expensive to be reliable");

  const moved = corr.pairs.filter((p) => p.kind === KIND.MOVE || p.kind === KIND.GROUP_MOVE && p.via === "move").length;
  const similar = corr.pairs.filter((p) => p.kind === KIND.TRANSFORM).length;
  const changedLines = corr.deletes.length + corr.inserts.length + similar + moved;
  let gran = changedLines <= o.tokenLines ? "token" : changedLines <= o.lineLines ? "line" : "simplified";
  if (options.granularity) gran = options.granularity;
  if (gran === "simplified") return simplifiedPlan(bl, al, `${changedLines} changed lines`);

  const em = new Emitter(bl, al);
  for (const p of corr.pairs) {
    if (p.exact) {
      let kind = p.kind;
      if (!kind) {
        const same = p.o === p.n && leadingWs(bl[p.o]) === leadingWs(al[p.n]);
        kind = same ? KIND.KEEP : KIND.LAYOUT_SHIFT;
      }
      em.lineAtom(kind, p.o, p.n, p.conf, p.group);
    } else if (gran === "token") {
      em.tokenPair(p.o, p.n, p.conf, o);
    } else {
      em.lineAtom(KIND.TRANSFORM, p.o, p.n, p.conf, undefined);
    }
  }
  for (const oi of corr.deletes) {
    if (gran === "token") em.tokenAtoms(KIND.DELETE, bl, oi, "from", 1);
    else em.lineAtom(KIND.DELETE, oi, null, 1);
  }
  for (const ni of corr.inserts) {
    if (gran === "token") em.tokenAtoms(KIND.INSERT, al, ni, "to", 1);
    else em.lineAtom(KIND.INSERT, null, ni, 1);
  }

  const atoms = em.atoms.sort((a, b) => {
    const la = (a.to ?? a.from).line, lb = (b.to ?? b.from).line;
    return la - lb || (a.to ?? a.from).col - (b.to ?? b.from).col;
  });
  const stats = {};
  for (const a of atoms) stats[a.kind] = (stats[a.kind] || 0) + 1;
  return { changed: true, granularity: gran, atoms, stats, changedLines, beforeLines: bl.length, afterLines: al.length };
}

/** Human summary for the UI, e.g. "2 moved, 5 removed, 8 added". */
export function summarize(plan) {
  if (!plan.changed) return "No changes";
  if (plan.granularity === "simplified") return "Large rewrite";
  const s = plan.stats, n = (k) => s[k] || 0;
  const parts = [];
  const moved = n("MOVE") + n("GROUP_MOVE");
  if (moved) parts.push(`${moved} moved`);
  if (n("TRANSFORM")) parts.push(`${n("TRANSFORM")} changed`);
  if (n("DELETE")) parts.push(`${n("DELETE")} removed`);
  if (n("INSERT")) parts.push(`${n("INSERT")} added`);
  return parts.join(", ") || "Layout shift";
}
