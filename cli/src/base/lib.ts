/**
 * Pure helpers for `levant base …` (no network) — unit-tested in test/base.test.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── migrations ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type Migration = { version: string; name: string; file: string; sql: string; checksum: string };

/** `20240101120000_create_todos.sql` → version 20240101120000, name create_todos (Supabase CLI layout). */
export function parseMigrationName(file: string): { version: string; name: string } {
  const base = path.basename(file).replace(/\.sql$/i, "");
  const m = base.match(/^(\d+)_(.+)$/);
  return m ? { version: m[1]!, name: m[2]! } : { version: base, name: base };
}

/** All `*.sql` files of a migrations folder, sorted by version (numeric prefixes compare numerically). */
export function readMigrations(dir: string): Migration[] {
  if (!fs.existsSync(dir)) throw new Error(`Migrations folder ${dir} does not exist`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      return { ...parseMigrationName(f), file: f, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
    })
    .sort(compareMigrations);
}

export function compareMigrations(a: { version: string; file: string }, b: { version: string; file: string }) {
  const na = /^\d+$/.test(a.version);
  const nb = /^\d+$/.test(b.version);
  if (na && nb && a.version.length !== b.version.length) return a.version.length - b.version.length;
  return a.version < b.version ? -1 : a.version > b.version ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export type Applied = { version: string; checksum: string | null; source: "levant" | "supabase" };

/** Which migrations still have to run; warns about edited files (checksum changed after being applied). */
export function planMigrations(local: Migration[], applied: Applied[]) {
  const byVersion = new Map(applied.map((a) => [a.version, a]));
  const pending: Migration[] = [];
  const changed: Migration[] = [];
  for (const m of local) {
    const a = byVersion.get(m.version);
    if (!a) pending.push(m);
    else if (a.checksum && a.checksum !== m.checksum) changed.push(m);
  }
  const localVersions = new Set(local.map((m) => m.version));
  const remoteOnly = applied.filter((a) => !localVersions.has(a.version)).map((a) => a.version);
  return { pending, changed, remoteOnly };
}

export const MIGRATIONS_TABLE_SQL = `create schema if not exists levant;
revoke all on schema levant from public, anon, authenticated;
create table if not exists levant.levant_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  applied_by text
);`;

/** applied versions: ours + the Supabase CLI history (projects migrated with pg_dump keep supabase_migrations). */
export const APPLIED_SQL = `select version, checksum, 'levant' as source from levant.levant_migrations
union all
select version, null, 'supabase' from supabase_migrations.schema_migrations
where to_regclass('supabase_migrations.schema_migrations') is not null
  and version not in (select version from levant.levant_migrations)
order by 1`;

export const APPLIED_SQL_NO_SUPABASE = `select version, checksum, 'levant' as source from levant.levant_migrations order by 1`;

export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** statements that cannot run inside a transaction block, or files that manage transactions themselves */
export function needsNoTransaction(sql: string): boolean {
  const s = stripComments(sql);
  return /\bconcurrently\b/i.test(s) || /^\s*(begin|commit|rollback|start\s+transaction)\b/im.test(s) || /\balter\s+type\b[\s\S]*?\badd\s+value\b/i.test(s) || /\bvacuum\b/i.test(s);
}

export function recordSql(m: Migration, by: string) {
  return `insert into levant.levant_migrations (version, name, checksum, applied_by) values (${lit(m.version)}, ${lit(m.name)}, ${lit(m.checksum)}, ${lit(by)})
on conflict (version) do update set checksum = excluded.checksum, name = excluded.name, applied_at = now(), applied_by = excluded.applied_by;`;
}

/** One API call per chunk: wrapped in a transaction (atomic with its history row) unless it can't be. */
export function migrationBatches(m: Migration, by: string, maxChars = 90_000): { sql: string; atomic: boolean }[] {
  const body = m.sql.trim().replace(/;?\s*$/, ";");
  const atomic = !needsNoTransaction(m.sql);
  if (atomic && body.length + 500 <= maxChars) return [{ sql: `begin;\n${body}\n${recordSql(m, by)}\ncommit;`, atomic: true }];
  if (body.length + 500 <= maxChars) return [{ sql: `${body}\n${recordSql(m, by)}`, atomic: false }];
  // too large for one request: split on statement boundaries (not atomic across requests)
  const chunks: string[] = [];
  let cur = "";
  for (const st of splitSql(m.sql)) {
    if (cur && cur.length + st.length + 2 > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + st;
  }
  if (cur) chunks.push(cur);
  chunks.push(recordSql(m, by));
  return chunks.map((sql) => ({ sql, atomic: false }));
}

/** Remove -- and /* *\/ comments (outside of quotes) — used for detection only. */
export function stripComments(sql: string): string {
  return splitSql(sql, { keepComments: false }).join("\n");
}

/**
 * Split SQL into statements on `;`, aware of '…' strings, "…" identifiers, $tag$…$tag$ bodies, -- and /* *\/ comments
 * and psql's `\` meta lines are kept as their own statements. Statements keep their trailing `;`.
 */
export function splitSql(sql: string, opts: { keepComments?: boolean } = {}): string[] {
  const keep = opts.keepComments !== false;
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  const push = () => {
    const t = cur.trim();
    if (t && t !== ";" && !/^(--[^\n]*\n?\s*)+$/.test(t)) out.push(t);
    cur = "";
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? n : end + 1;
      if (keep) cur += sql.slice(i, stop);
      else cur += "\n";
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") (depth++, (j += 2));
        else if (sql[j] === "*" && sql[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      if (keep) cur += sql.slice(i, j);
      else cur += " ";
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? n : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === "\\" && cur.trim() === "") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      cur += sql.slice(i, stop);
      push();
      i = stop;
      continue;
    }
    cur += c;
    i++;
    if (c === ";") push();
  }
  push();
  return out;
}

// ── env files ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function baseEnv(url: string, anonKey: string, serviceRoleKey?: string | null): Record<string, string> {
  const env: Record<string, string> = {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: anonKey,
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: anonKey,
    EXPO_PUBLIC_SUPABASE_URL: url,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: anonKey,
  };
  if (serviceRoleKey) env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
  return env;
}

const quote = (v: string) => (/^[A-Za-z0-9_./:@+-]*$/.test(v) ? v : JSON.stringify(v));

/** Update KEY=… lines in an existing .env text (keeps comments, order and unrelated keys); appends new keys. */
export function mergeEnvFile(existing: string, vars: Record<string, string>, header = "# LevantBase"): string {
  const left = new Map(Object.entries(vars));
  const lines = existing ? existing.replace(/\n$/, "").split("\n") : [];
  const out = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && left.has(m[1]!)) {
      const v = left.get(m[1]!)!;
      left.delete(m[1]!);
      return `${m[1]}=${quote(v)}`;
    }
    return line;
  });
  if (left.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(header);
    for (const [k, v] of left) out.push(`${k}=${quote(v)}`);
  }
  return out.join("\n") + "\n";
}

// ── functions ────────────────────────────────────────────────────────────────────────────────────────────────────────

const FN_EXT = /\.(ts|tsx|js|jsx|mjs|mts|json|jsonc|wasm|txt|html|md|sql|csv)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", "dist", "coverage", "__tests__", "tests", "test"]);

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) out.push(...walk(dir, r));
    } else if (e.isFile() && FN_EXT.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) out.push(r);
  }
  return out.sort();
}

export type FunctionBundle = { code: string; files: Record<string, string>; entry: string; shared: string[]; warnings: string[] };

/**
 * Collect a Supabase-style function folder (`supabase/functions/<slug>/index.ts` + helpers). Imports of the
 * conventional sibling folder `../_shared/…` are supported: those files are uploaded as `_shared/…` inside the
 * function and the specifiers are rewritten to `./_shared/…` (`../_shared` from nested files stays correct relative
 * to the function root via the same rewrite depth).
 */
export function bundleFunction(dir: string): FunctionBundle {
  const entry = ["index.ts", "index.js", "index.tsx", "index.mjs"].find((f) => fs.existsSync(path.join(dir, f)));
  if (!entry) throw new Error(`No index.ts in ${dir}`);
  const warnings: string[] = [];
  const files: Record<string, string> = {};
  for (const rel of walk(dir)) if (rel !== entry) files[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
  let code = fs.readFileSync(path.join(dir, entry), "utf8");
  if (entry !== "index.ts") code = `export * from "./${entry}";\nimport "./${entry}";\n`, (files[entry] = fs.readFileSync(path.join(dir, entry), "utf8"));
  const sharedDir = path.join(path.dirname(dir), "_shared");
  const usesShared = (s: string) => /(['"])(\.\.\/)+_shared\//.test(s);
  const shared: string[] = [];
  if ([code, ...Object.values(files)].some(usesShared)) {
    if (!fs.existsSync(sharedDir)) warnings.push(`imports ../_shared but ${sharedDir} does not exist`);
    else for (const rel of walk(sharedDir)) (files[`_shared/${rel}`] = fs.readFileSync(path.join(sharedDir, rel), "utf8")), shared.push(rel);
    // rewrite ../_shared/ (from the function root) and ../../_shared/ (from one level down) …
    const rewrite = (src: string, depth: number) => src.replace(/(['"])((?:\.\.\/)+)_shared\//g, (m, q: string, ups: string) => (ups.length / 3 === depth + 1 ? `${q}${depth === 0 ? "./" : "../".repeat(depth)}_shared/` : m));
    code = rewrite(code, 0);
    for (const k of Object.keys(files)) if (!k.startsWith("_shared/") && /\.(m?[jt]sx?)$/.test(k)) files[k] = rewrite(files[k]!, k.split("/").length - 1);
  }
  for (const f of ["deno.json", "deno.jsonc", "import_map.json"]) {
    if (files[f]) warnings.push(`${f} is uploaded but per-function import maps are not applied — use full specifiers (npm:, jsr:, https:) in imports`);
  }
  const size = Buffer.byteLength(code) + Object.values(files).reduce((a, s) => a + Buffer.byteLength(s), 0);
  if (size > 2 * 1024 * 1024) throw new Error(`Function is ${Math.round(size / 1024)} KB — the limit is 2 MB`);
  return { code, files, entry, shared, warnings };
}

/** `supabase/config.toml` → { slug: verify_jwt } from `[functions.<slug>] verify_jwt = false` blocks. */
export function functionsConfig(toml: string): Record<string, { verifyJwt?: boolean }> {
  const out: Record<string, { verifyJwt?: boolean }> = {};
  let cur: string | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[functions\.("?)([A-Za-z0-9_-]+)\1\]$/);
    if (sec) {
      cur = sec[2]!;
      out[cur] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      cur = null;
      continue;
    }
    const kv = line.match(/^verify_jwt\s*=\s*(true|false)$/);
    if (cur && kv) out[cur]!.verifyJwt = kv[1] === "true";
  }
  return out;
}

/** Folder layout of an existing app: `supabase/` (Supabase CLI) at the root of `dir`. */
export function supabaseDir(dir: string): string {
  return path.join(dir, "supabase");
}

export function parseKeyValues(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new Error(`Expected KEY=value, got "${p}"`);
    const k = p.slice(0, i).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid secret name "${k}" (use UPPER_CASE letters, digits and _)`);
    out[k] = p.slice(i + 1);
  }
  return out;
}

/** Parse a .env file (KEY=value, quotes, export prefix, comments) — used by `secrets set --env-file`. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^"(.*)"$/.test(v)) v = JSON.parse(v) as string;
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}
