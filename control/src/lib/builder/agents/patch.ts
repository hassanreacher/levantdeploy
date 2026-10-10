/**
 * Search/replace patching with tolerant matching (weak models rarely reproduce whitespace exactly) + a compact
 * line diff for progress events.
 */

export type Edit = { search: string; replace: string };

export class PatchError extends Error {}

/** Parses aider-style blocks:
 * <<<<<<< SEARCH
 * old
 * =======
 * new
 * >>>>>>> REPLACE
 * Markers are matched leniently (5-9 chars, optional words). */
export function parseSearchReplaceBlocks(text: string): Edit[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const edits: Edit[] = [];
  let i = 0;
  const isStart = (l: string) => /^\s*<{5,9}\s*(SEARCH|ORIGINAL|FIND)?\s*$/i.test(l);
  const isMid = (l: string) => /^\s*={5,9}\s*$/.test(l);
  const isEnd = (l: string) => /^\s*>{5,9}\s*(REPLACE|UPDATED)?\s*$/i.test(l);
  while (i < lines.length) {
    if (!isStart(lines[i])) {
      i++;
      continue;
    }
    i++;
    const search: string[] = [];
    while (i < lines.length && !isMid(lines[i])) search.push(lines[i++]);
    if (i >= lines.length) throw new PatchError("Unterminated SEARCH block (missing =======)");
    i++;
    const replace: string[] = [];
    while (i < lines.length && !isEnd(lines[i])) replace.push(lines[i++]);
    if (i >= lines.length) throw new PatchError("Unterminated REPLACE block (missing >>>>>>> REPLACE)");
    i++;
    edits.push({ search: search.join("\n"), replace: replace.join("\n") });
  }
  return edits;
}

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0];

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // bigram Dice coefficient — cheap and robust for code lines
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * inter) / total;
}

function trimBlankEdges(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) s++;
  while (e > s && !lines[e - 1].trim()) e--;
  return lines.slice(s, e);
}

/** Applies one edit. Returns the new content and the strategy that matched. */
export function applyEdit(content: string, edit: Edit): { content: string; strategy: string } {
  const src = content.replace(/\r\n/g, "\n");
  const search = edit.search.replace(/\r\n/g, "\n");
  const replace = edit.replace.replace(/\r\n/g, "\n");
  if (!search.trim()) {
    // empty search = append (or create)
    const sep = src.length && !src.endsWith("\n") ? "\n" : "";
    return { content: src + sep + replace + (replace.endsWith("\n") ? "" : "\n"), strategy: "append" };
  }

  // 1. exact
  const first = src.indexOf(search);
  if (first >= 0) {
    if (src.indexOf(search, first + 1) >= 0) throw new PatchError("SEARCH text matches more than one place — include more surrounding lines so it is unique");
    return { content: src.slice(0, first) + replace + src.slice(first + search.length), strategy: "exact" };
  }

  const fileLines = src.split("\n");
  const sLines = trimBlankEdges(search.split("\n"));
  const rLines = replace.split("\n");
  if (!sLines.length) throw new PatchError("SEARCH block is empty");
  const n = sLines.length;

  const splice = (start: number, end: number, newLines: string[]) => [...fileLines.slice(0, start), ...newLines, ...fileLines.slice(end)].join("\n");

  // 2. trailing whitespace insensitive, 3. indentation insensitive (re-indent the replacement)
  for (const mode of ["rtrim", "trim"] as const) {
    const norm = (l: string) => (mode === "rtrim" ? l.trimEnd() : l.trim());
    const target = sLines.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + n <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (norm(fileLines[i + j]) !== target[j]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    if (hits.length > 1) throw new PatchError("SEARCH text matches more than one place — include more surrounding lines so it is unique");
    if (hits.length === 1) {
      const i = hits[0];
      let out = trimBlankEdges(rLines);
      if (mode === "trim") {
        // shift the replacement's indentation by the difference between file and search first lines
        const fileInd = indentOf(fileLines[i]);
        const searchInd = indentOf(sLines[0]);
        out = out.map((l) => (l.trim() ? (l.startsWith(searchInd) ? fileInd + l.slice(searchInd.length) : fileInd + l.trimStart()) : l));
      }
      return { content: splice(i, i + n, out), strategy: mode === "rtrim" ? "whitespace" : "indent" };
    }
  }

  // 4. fuzzy: best window by line similarity (ignoring indentation)
  let best = -1;
  let bestScore = 0;
  let second = 0;
  const target = sLines.map((l) => l.trim());
  for (const len of [n, n - 1, n + 1]) {
    if (len < 1) continue;
    for (let i = 0; i + len <= fileLines.length; i++) {
      const win = fileLines.slice(i, i + len).map((l) => l.trim()).join("\n");
      const score = similarity(win, target.join("\n"));
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = i * 1000 + len;
      } else if (score > second) second = score;
    }
  }
  if (best >= 0 && bestScore >= 0.88 && bestScore - second > 0.02) {
    const i = Math.floor(best / 1000);
    const len = best % 1000;
    const fileInd = indentOf(fileLines[i]);
    const searchInd = indentOf(sLines[0]);
    const out = trimBlankEdges(rLines).map((l) => (l.trim() ? (l.startsWith(searchInd) ? fileInd + l.slice(searchInd.length) : fileInd + l.trimStart()) : l));
    return { content: splice(i, i + len, out), strategy: `fuzzy(${bestScore.toFixed(2)})` };
  }
  throw new PatchError(
    `SEARCH text not found in the file${bestScore > 0.5 ? ` (closest match ${Math.round(bestScore * 100)}% similar)` : ""}. Re-read the file with read_file and copy the exact lines.`,
  );
}

export function applyEdits(content: string, edits: Edit[]): { content: string; strategies: string[] } {
  let cur = content;
  const strategies: string[] = [];
  edits.forEach((e, idx) => {
    try {
      const r = applyEdit(cur, e);
      cur = r.content;
      strategies.push(r.strategy);
    } catch (err) {
      throw new PatchError(`edit #${idx + 1}: ${(err as Error).message}`);
    }
  });
  return { content: cur, strategies };
}

// ───────────────────────────── diff ─────────────────────────────

/** Unified-ish line diff (Myers via LCS table on trimmed window). Bounded for large files. */
export function lineDiff(before: string, after: string, opts: { context?: number; maxLines?: number } = {}): string {
  const ctx = opts.context ?? 2;
  const maxLines = opts.maxLines ?? 400;
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  if (before === after) return "";
  // trim common prefix / suffix
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: { t: " " | "-" | "+"; l: string; ai: number; bi: number }[] = [];
  if (am.length * bm.length > 4_000_000) {
    am.forEach((l, i) => ops.push({ t: "-", l, ai: pre + i, bi: pre }));
    bm.forEach((l, i) => ops.push({ t: "+", l, ai: pre + am.length, bi: pre + i }));
  } else {
    const m = am.length;
    const n = bm.length;
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && am[i] === bm[j]) {
        ops.push({ t: " ", l: am[i], ai: pre + i, bi: pre + j });
        i++;
        j++;
      } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ t: "+", l: bm[j], ai: pre + i, bi: pre + j });
        j++;
      } else {
        ops.push({ t: "-", l: am[i], ai: pre + i, bi: pre + j });
        i++;
      }
    }
  }
  const head = a.slice(Math.max(0, pre - ctx), pre).map((l) => ` ${l}`);
  const tail = a.slice(a.length - suf, a.length - suf + ctx).map((l) => ` ${l}`);
  const body = ops.map((o) => `${o.t}${o.l}`);
  const out = [`@@ -${Math.max(1, pre - ctx + 1)} +${Math.max(1, pre - ctx + 1)} @@`, ...head, ...body, ...tail];
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… (${out.length - maxLines} more lines)`].join("\n");
  return out.join("\n");
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}
