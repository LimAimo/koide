// Bounded, exact line comparison for historical snapshots. Independent of Diffusion animation.
const lines = (text) => (text || "").match(/[^\n]*\n|[^\n]+$/g) || [];

export function lineDiff(before, after, { maxCells = 2_000_000, context = 3 } = {}) {
  if ((before?.length || 0) + (after?.length || 0) > 1_048_576) return { limited: true };
  const old = lines(before), next = lines(after);
  if (old.length + next.length > 20_000) return { limited: true };
  let prefix = 0, aEnd = old.length, bEnd = next.length;
  while (prefix < aEnd && prefix < bEnd && old[prefix] === next[prefix]) prefix++;
  while (aEnd > prefix && bEnd > prefix && old[aEnd - 1] === next[bEnd - 1]) { aEnd--; bEnd--; }
  const n = aEnd - prefix, m = bEnd - prefix, width = m + 1;
  if ((n + 1) * (m + 1) > maxCells && n && m) return { limited: true };
  const dp = n && m ? new Uint16Array((n + 1) * (m + 1)) : null;
  if (dp) for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * width + j] = old[prefix + i] === next[prefix + j]
      ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  }
  const rows = [];
  let a = 0, b = 0, added = 0, deleted = 0;
  const row = (kind) => {
    const raw = kind === "insert" ? next[b] : old[a];
    rows.push({ kind, oldLine: kind === "insert" ? null : a + 1, newLine: kind === "delete" ? null : b + 1,
      text: raw.replace(/\r?\n$/, ""), noNewline: !raw.endsWith("\n") });
    if (kind !== "insert") a++;
    if (kind !== "delete") b++;
    if (kind === "insert") added++;
    if (kind === "delete") deleted++;
  };
  while (a < prefix) row("equal");
  while (a < aEnd || b < bEnd) {
    if (a < aEnd && b < bEnd && old[a] === next[b]) row("equal");
    else if (b >= bEnd || (a < aEnd && dp && dp[(a - prefix + 1) * width + b - prefix] >= dp[(a - prefix) * width + b - prefix + 1])) row("delete");
    else row("insert");
  }
  while (a < old.length) row("equal");
  const spans = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].kind !== "equal") {
    const start = Math.max(0, i - context), end = Math.min(rows.length, i + context + 1), last = spans.at(-1);
    if (last && start <= last.end) last.end = end;
    else spans.push({ start, end });
  }
  const hunks = spans.map(({ start, end }) => {
    const part = rows.slice(start, end), changes = part.filter((r) => r.kind !== "equal");
    const range = (key) => { const values = changes.map((r) => r[key]).filter((v) => v != null); return values.length ? [values[0], values.at(-1)] : null; };
    const oldRange = range("oldLine"), newRange = range("newLine");
    return { rows: part, oldRange, newRange, kind: oldRange && newRange ? "change" : oldRange ? "delete" : "insert" };
  });
  return { limited: false, added, deleted, hunks };
}

/** Group validation by exact command and cwd. Passing another command cannot resolve a failure. */
export function validationStories(events) {
  const stories = new Map();
  for (const [index, event] of events.entries()) {
    if (!["build_failed", "build_ok"].includes(event.type)) continue;
    const command = event.arguments?.command?.trim();
    const key = command ? JSON.stringify([command, event.arguments?.cwd || "."]) : `unknown:${index}`;
    if (event.type === "build_failed") stories.set(key, { failure: event, index, command, pass: null });
    else if (stories.has(key)) stories.get(key).pass = event;
  }
  return [...stories.values()].map((story) => {
    const passIndex = story.pass ? events.indexOf(story.pass) : events.length;
    const edits = events.slice(story.index + 1, passIndex).filter((event) => event.type === "edit");
    const stale = story.pass && (edits.some((event) => event.reverted) || events.slice(passIndex + 1).some((event) => event.type === "edit"));
    return { ...story, edits, state: !story.pass ? "open" : stale ? "stale" : edits.length ? "fixed" : "retried" };
  }).sort((a, b) => b.index - a.index);
}
