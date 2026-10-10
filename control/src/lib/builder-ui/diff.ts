/** builder-ui: tiny unified-diff helpers (file-change cards, History and Code "diff vs previous"). */

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; oldNo?: number; newNo?: number };
export type DiffFile = { path: string; oldPath?: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; lines: DiffLine[] };

/** Parse a (multi-file) unified diff (git diff output) — tolerant of a single-file patch without the `diff --git` header. */
export function parseUnifiedDiff(patch: string, fallbackPath = "file"): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let o = 0;
  let n = 0;
  const start = (path: string) => {
    cur = { path, status: "modified", additions: 0, deletions: 0, lines: [] };
    files.push(cur);
  };
  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(raw);
      start(m?.[1] ?? fallbackPath);
      continue;
    }
    if (!cur) {
      if (raw.startsWith("--- ") || raw.startsWith("@@")) start(fallbackPath);
      else continue;
    }
    const f = cur!;
    if (raw.startsWith("new file mode")) f.status = "added";
    else if (raw.startsWith("deleted file mode")) f.status = "deleted";
    else if (raw.startsWith("rename from ")) {
      f.status = "renamed";
      f.oldPath = raw.slice(12);
    } else if (raw.startsWith("--- ")) {
      if (raw === "--- /dev/null") f.status = "added";
    } else if (raw.startsWith("+++ ")) {
      if (raw === "+++ /dev/null") f.status = "deleted";
      else if (f.path === fallbackPath) f.path = raw.slice(4).replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      o = Number(m?.[1] ?? 1);
      n = Number(m?.[2] ?? 1);
      f.lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      f.additions++;
      f.lines.push({ kind: "add", text: raw.slice(1), newNo: n++ });
    } else if (raw.startsWith("-")) {
      f.deletions++;
      f.lines.push({ kind: "del", text: raw.slice(1), oldNo: o++ });
    } else if (raw.startsWith(" ")) {
      f.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: o++, newNo: n++ });
    } else if (raw.startsWith("\\")) {
      f.lines.push({ kind: "meta", text: raw });
    }
  }
  return files;
}

/**
 * Line diff of two texts (LCS on lines; fine for source files of a few thousand lines) → DiffLine[] with context
 * collapsed to `context` lines around changes.
 */
export function diffTexts(a: string, b: string, context = 3): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // trim common prefix/suffix to keep the DP small
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xa = x.slice(pre, x.length - suf);
  const ya = y.slice(pre, y.length - suf);
  const all: DiffLine[] = [];
  for (let i = 0; i < pre; i++) all.push({ kind: "ctx", text: x[i]!, oldNo: i + 1, newNo: i + 1 });
  if (xa.length * ya.length > 4_000_000) {
    // too big for LCS: show as full replacement
    xa.forEach((t, i) => all.push({ kind: "del", text: t, oldNo: pre + i + 1 }));
    ya.forEach((t, i) => all.push({ kind: "add", text: t, newNo: pre + i + 1 }));
  } else {
    const m = xa.length;
    const n = ya.length;
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i]![j] = xa[i] === ya[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && xa[i] === ya[j]) {
        all.push({ kind: "ctx", text: xa[i]!, oldNo: pre + i + 1, newNo: pre + j + 1 });
        i++;
        j++;
      } else if (j < n && (i >= m || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
        all.push({ kind: "add", text: ya[j]!, newNo: pre + j + 1 });
        j++;
      } else {
        all.push({ kind: "del", text: xa[i]!, oldNo: pre + i + 1 });
        i++;
      }
    }
  }
  for (let k = 0; k < suf; k++) all.push({ kind: "ctx", text: x[x.length - suf + k]!, oldNo: x.length - suf + k + 1, newNo: y.length - suf + k + 1 });
  return collapse(all, context);
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== "ctx") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: "hunk", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: "hunk", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

export function diffStats(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.kind === "add") additions++;
    else if (l.kind === "del") deletions++;
  }
  return { additions, deletions };
}
