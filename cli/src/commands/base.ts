/**
 * `levant base …` — LevantBase backend projects (Postgres + Auth + REST + Realtime + Storage + Edge Functions) from
 * the terminal. Works with the folder layout of existing apps: `supabase/migrations/*.sql`, `supabase/functions/<slug>/`,
 * `supabase/config.toml` (`[functions.<slug>] verify_jwt`).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import open from "open";
import { Client, CliError } from "../api.js";
import { readConfig, readLink } from "../config.js";
import { listProjects } from "../project.js";
import { c, confirm, info, isTTY, ok, select, table, timeAgo, warn } from "../ui.js";
import {
  APPLIED_SQL,
  APPLIED_SQL_NO_SUPABASE,
  MIGRATIONS_TABLE_SQL,
  baseEnv,
  bundleFunction,
  functionsConfig,
  mergeEnvFile,
  migrationBatches,
  parseEnvFile,
  parseKeyValues,
  planMigrations,
  readMigrations,
  supabaseDir,
  type Applied,
} from "../base/lib.js";

export type BaseProject = {
  id: string;
  ref: string;
  name: string;
  status: string;
  apiUrl: string;
  studioUrl: string;
  createdAt: string;
  lastActivityAt: string | null;
  versions: Record<string, string>;
  project: { id: string; slug: string; name: string } | null;
  errorMessage: string | null;
};
export type BaseLink = { server: string; ref: string; name: string; teamSlug: string };
type Common = { ref?: string; team?: string; yes?: boolean };

const P = (ref: string, sub = "") => `/api/v1/base/projects/${ref}${sub}`;
export const baseLinkFile = (dir: string) => path.join(dir, ".levant", "base.json");

export function readBaseLink(dir: string): BaseLink | null {
  try {
    return JSON.parse(fs.readFileSync(baseLinkFile(dir), "utf8")) as BaseLink;
  } catch {
    return null;
  }
}

export function writeBaseLink(dir: string, link: BaseLink) {
  fs.mkdirSync(path.dirname(baseLinkFile(dir)), { recursive: true });
  fs.writeFileSync(baseLinkFile(dir), JSON.stringify(link, null, 2) + "\n");
  const gi = path.join(dir, ".gitignore");
  try {
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : null;
    if (cur !== null && !/^\.levant\/?$/m.test(cur)) fs.appendFileSync(gi, `${cur.endsWith("\n") || !cur ? "" : "\n"}.levant\n`);
  } catch {}
}

const teamOf = (_client: Client, opts: { team?: string }) => opts.team ?? readLink(process.cwd())?.teamSlug ?? readConfig().team ?? undefined;

async function teamSlug(client: Client, team?: string): Promise<string> {
  if (team) return team;
  const r = await client.request<{ teams: Array<{ slug: string }> }>("GET", "/api/v1/teams").catch(() => null);
  const t = r?.teams?.[0]?.slug;
  if (!t) throw new CliError("Pass --team <slug>");
  return t;
}

async function listBases(client: Client, team: string) {
  return (await client.request<{ items: BaseProject[] }>("GET", "/api/v1/base/projects", { query: { team } })).items;
}

/** --ref, the folder's .levant/base.json, or the backend attached to the linked Deploy project. */
export async function resolveBase(client: Client, opts: Common = {}): Promise<BaseProject> {
  let ref = opts.ref;
  if (!ref) {
    const l = readBaseLink(process.cwd());
    if (l && l.server === client.server) ref = l.ref;
  }
  if (!ref) {
    const dl = readLink(process.cwd());
    if (dl && dl.server === client.server) {
      const items = await listBases(client, dl.teamSlug);
      const attached = items.find((b) => b.project?.id === dl.projectId);
      if (attached) return attached;
    }
    throw new CliError("No Base project linked to this folder. Run `levant base link` (or pass --ref).");
  }
  if (!/^[a-z]{20}$/.test(ref)) {
    // a name: look it up in the team
    const items = await listBases(client, await teamSlug(client, teamOf(client, opts)));
    const hit = items.find((b) => b.name === ref);
    if (!hit) throw new CliError(`Base project "${ref}" not found`);
    return hit;
  }
  return (await client.request<{ project: BaseProject }>("GET", P(ref))).project;
}

const STATUS_COLOR: Record<string, (s: string) => string> = { ACTIVE: c.green, ERROR: c.red, PAUSED: c.dim, PROVISIONING: c.yellow };
const st = (s: string) => (STATUS_COLOR[s] ?? c.yellow)(`● ${s[0]}${s.slice(1).toLowerCase()}`);

// ── ls / create / link / status ─────────────────────────────────────────────────────────────────────────────────────

export async function baseLs(client: Client, opts: { team?: string; json?: boolean }) {
  const team = await teamSlug(client, teamOf(client, opts));
  const items = await listBases(client, team);
  if (opts.json) return console.log(JSON.stringify(items, null, 2));
  info(c.dim(`Base projects of ${team}\n`));
  if (!items.length) return info("No Base projects yet. Run `levant base create <name>`.");
  const linked = readBaseLink(process.cwd())?.ref;
  table(
    items.map((b) => [(b.ref === linked ? c.cyan("› ") : "  ") + b.name, c.dim(b.ref), st(b.status), b.apiUrl, c.dim(b.project ? b.project.slug : "—"), c.dim(timeAgo(b.createdAt))]),
    ["Name", "Ref", "Status", "API URL", "Project", "Created"],
  );
}

async function waitActive(client: Client, ref: string, timeoutMs = 15 * 60_000): Promise<BaseProject> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const p = (await client.request<{ project: BaseProject }>("GET", P(ref))).project;
    if (p.status !== last) {
      if (last) info(c.dim(`  ${p.status.toLowerCase()}`));
      last = p.status;
    }
    if (p.status === "ACTIVE") return p;
    if (p.status === "ERROR") throw new CliError(`Provisioning failed: ${p.errorMessage ?? "see the dashboard"}`);
    if (Date.now() > deadline) throw new CliError(`Still ${p.status.toLowerCase()} after ${Math.round(timeoutMs / 60000)} min — check the dashboard`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function baseCreate(client: Client, name: string, opts: { team?: string; project?: string; dbPassword?: string; wait?: boolean; link?: boolean; serviceRole?: boolean }) {
  const team = await teamSlug(client, teamOf(client, opts));
  let projectId: string | undefined;
  if (opts.project !== undefined) {
    const slug = typeof opts.project === "string" && opts.project ? opts.project : readLink(process.cwd())?.projectSlug;
    if (!slug) throw new CliError("--project needs a project slug (or run it in a folder linked with `levant link`)");
    const { items } = await listProjects(client, team);
    const p = items.find((x) => x.slug === slug || x.id === slug);
    if (!p) throw new CliError(`Project "${slug}" not found in ${team}`);
    projectId = p.id;
  }
  const r = await client.request<{ project: BaseProject }>("POST", "/api/v1/base/projects", {
    body: { team, name, ...(opts.dbPassword ? { dbPassword: opts.dbPassword } : {}), ...(projectId ? { projectId, connectEnv: true, includeServiceRole: !!opts.serviceRole } : {}) },
  });
  let p = r.project;
  ok(`Created Base project ${c.bold(p.name)} ${c.dim(`(${p.ref})`)}${projectId ? ` for ${c.bold(opts.project || "the linked project")} — env vars added to it` : ""}`);
  if (opts.link !== false) {
    writeBaseLink(process.cwd(), { server: client.server, ref: p.ref, name: p.name, teamSlug: team });
    info(c.dim(`  linked this folder (.levant/base.json)`));
  }
  if (opts.wait !== false) {
    info(c.dim("  provisioning (database, auth, REST, realtime, storage, functions)…"));
    p = await waitActive(client, p.ref);
    ok(`Ready: ${c.cyan(p.apiUrl)}`);
    info(c.dim("  Next: `levant base env pull` → .env.local, `levant base db push`, `levant base functions deploy`"));
  }
  return p;
}

export async function baseLink(client: Client, refArg: string | undefined, opts: { team?: string; yes?: boolean }) {
  const team = await teamSlug(client, teamOf(client, opts));
  const items = await listBases(client, team);
  let p: BaseProject | undefined;
  if (refArg) p = items.find((b) => b.ref === refArg || b.name === refArg);
  else {
    const dl = readLink(process.cwd());
    const attached = dl ? items.find((b) => b.project?.id === dl.projectId) : undefined;
    if (attached && (opts.yes || !isTTY() || (await confirm(`Link to ${c.bold(attached.name)} (backend of ${attached.project!.slug})?`)))) p = attached;
    else if (items.length === 1 && (opts.yes || !isTTY())) p = items[0];
    else if (items.length && isTTY()) p = await select("Which Base project?", items.map((b) => ({ label: `${b.name} ${c.dim(b.ref)} ${st(b.status)}`, value: b })));
  }
  if (!p) throw new CliError(refArg ? `Base project "${refArg}" not found in ${team}` : `No Base project to link in ${team} — run \`levant base create <name>\``);
  writeBaseLink(process.cwd(), { server: client.server, ref: p.ref, name: p.name, teamSlug: team });
  ok(`Linked ${c.dim(process.cwd())} → ${c.bold(p.name)} ${c.dim(`(${p.ref})`)}`);
  return p;
}

export async function baseStatus(client: Client, opts: Common & { json?: boolean }) {
  const p = await resolveBase(client, opts);
  const h = await client.request<{ status: string; services: Array<{ service: string; state: string; health?: string; healthy?: boolean; running?: boolean }> }>("GET", P(p.ref, "/health")).catch(() => null);
  if (opts.json) return console.log(JSON.stringify({ project: p, services: h?.services ?? [] }, null, 2));
  info(`${c.bold(p.name)} ${c.dim(p.ref)}  ${st(p.status)}${p.errorMessage ? c.red(`  ${p.errorMessage}`) : ""}`);
  info(`  API      ${c.cyan(p.apiUrl)}`);
  info(`  Studio   ${c.dim("levant base studio")}`);
  if (p.project) info(`  Project  ${p.project.slug}`);
  if (p.lastActivityAt) info(`  Activity ${c.dim(timeAgo(p.lastActivityAt))}`);
  if (h?.services?.length) {
    info("");
    table(
      h.services.map((s) => [s.service, s.healthy || s.health === "healthy" ? c.green("healthy") : s.state === "running" || s.running ? (s.health && s.health !== "healthy" ? c.yellow(s.health) : c.green("running")) : c.red(s.state), c.dim(p.versions[s.service === "api-gw" ? "gateway" : s.service] ?? "")]),
      ["Service", "State", "Image"],
    );
  }
}

// ── keys / env ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function keys(client: Client, ref: string, service: boolean) {
  return client.request<{ url: string; anonKey: string; serviceRoleKey?: string }>("GET", P(ref, "/keys"), { query: { reveal: service ? "service_role" : undefined } });
}

export async function baseKeys(client: Client, opts: Common & { service?: boolean; json?: boolean }) {
  const p = await resolveBase(client, opts);
  if (opts.service) warn("The service_role key bypasses Row Level Security. Keep it on servers only — never in browser or mobile code.");
  const k = await keys(client, p.ref, !!opts.service);
  if (opts.json) return console.log(JSON.stringify(k, null, 2));
  console.log(`url               ${k.url}`);
  console.log(`anon key          ${k.anonKey}`);
  if (k.serviceRoleKey) console.log(`service_role key  ${k.serviceRoleKey}`);
}

export async function baseEnvPull(client: Client, file: string | undefined, opts: Common & { service?: boolean }) {
  const p = await resolveBase(client, opts);
  if (opts.service) warn("Writing SUPABASE_SERVICE_ROLE_KEY — make sure this file is never committed or shipped to clients.");
  const k = await keys(client, p.ref, !!opts.service);
  const target = path.resolve(file ?? ".env.local");
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const vars = baseEnv(k.url, k.anonKey, k.serviceRoleKey ?? null);
  fs.writeFileSync(target, mergeEnvFile(existing, vars, `# LevantBase ${p.name} (${p.ref}) — levant base env pull`), { mode: 0o600 });
  ok(`Wrote ${Object.keys(vars).length} variables to ${c.bold(path.relative(process.cwd(), target) || target)}`);
  const gi = path.join(process.cwd(), ".gitignore");
  if (fs.existsSync(gi) && !fs.readFileSync(gi, "utf8").split("\n").some((l) => l.trim() === path.basename(target) || l.trim() === ".env*" || l.trim() === ".env*.local")) {
    warn(`${path.basename(target)} is not in .gitignore`);
  }
}

// ── database ────────────────────────────────────────────────────────────────────────────────────────────────────────

type SqlResult = { rows: Array<Record<string, string | null>>; rowCount: number; fields?: Array<{ name: string } | string> };
export async function runSql(client: Client, ref: string, sql: string): Promise<SqlResult> {
  return client.request<SqlResult>("POST", P(ref, "/sql"), { body: { sql, maxRows: 5000 } });
}

export async function baseDbUrl(client: Client, opts: Common & { reveal?: boolean }) {
  const p = await resolveBase(client, opts);
  const r = await client.request<{ direct: string; pooler: string | null; publicUrl: string | null; host: string; port: number; password?: string }>("GET", P(p.ref, "/connection"), {
    query: { reveal: opts.reveal ? "1" : undefined },
  });
  const best = r.publicUrl ?? r.pooler ?? r.direct;
  console.log(best);
  if (!r.publicUrl) {
    info(c.dim("\n  The database has no public port: this URL works for apps deployed on this LevantDeploy server."));
    info(c.dim("  From your machine use `levant base db push|dump`, the SQL editor or Studio (`levant base studio`)."));
  }
  if (!opts.reveal) info(c.dim("  Password hidden — add --reveal (team admins)."));
}

export async function baseSql(client: Client, sqlArg: string | undefined, opts: Common & { file?: string; json?: boolean }) {
  const p = await resolveBase(client, opts);
  const sql = opts.file ? fs.readFileSync(opts.file, "utf8") : sqlArg ?? (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"));
  if (!sql.trim()) throw new CliError("Pass a statement, --file or SQL on stdin");
  const r = await runSql(client, p.ref, sql);
  if (opts.json) return console.log(JSON.stringify(r.rows, null, 2));
  const cols = (r.fields ?? []).map((f) => (typeof f === "string" ? f : f.name));
  if (cols.length) table(r.rows.map((row) => cols.map((k) => row[k] ?? c.dim("null"))), cols);
  info(c.dim(`${r.rowCount} row${r.rowCount === 1 ? "" : "s"}`));
}

export async function baseDbPush(client: Client, dirArg: string | undefined, opts: Common & { dryRun?: boolean; includeAll?: boolean }) {
  const p = await resolveBase(client, opts);
  const dir = path.resolve(dirArg ?? path.join(supabaseDir(process.cwd()), "migrations"));
  const local = readMigrations(dir);
  if (!local.length) return info(`No .sql files in ${dir}`);
  await runSql(client, p.ref, MIGRATIONS_TABLE_SQL);
  let applied: Applied[];
  try {
    applied = (await runSql(client, p.ref, APPLIED_SQL)).rows.map((r) => ({ version: r.version!, checksum: r.checksum, source: r.source as Applied["source"] }));
  } catch {
    applied = (await runSql(client, p.ref, APPLIED_SQL_NO_SUPABASE)).rows.map((r) => ({ version: r.version!, checksum: r.checksum, source: "levant" as const }));
  }
  const plan = planMigrations(local, applied);
  for (const m of plan.changed) warn(`${m.file} changed after it was applied — not re-run (create a new migration instead)`);
  if (plan.remoteOnly.length) info(c.dim(`  ${plan.remoteOnly.length} migration(s) applied remotely but not in ${path.relative(process.cwd(), dir) || dir}: ${plan.remoteOnly.slice(0, 5).join(", ")}${plan.remoteOnly.length > 5 ? "…" : ""}`));
  if (!plan.pending.length) return ok(`Database is up to date (${local.length} migration${local.length === 1 ? "" : "s"})`);
  info(`${plan.pending.length} pending migration${plan.pending.length === 1 ? "" : "s"} for ${c.bold(p.name)}:`);
  for (const m of plan.pending) info(`  ${c.cyan(m.version)} ${m.name}`);
  if (opts.dryRun) return info(c.dim("\n  --dry-run: nothing applied"));
  if (!opts.yes && isTTY() && !(await confirm("Apply them now?"))) return 130;
  const me = await client.request<{ user?: { email?: string } }>("GET", "/api/v1/me").catch(() => null);
  const by = me?.user?.email ?? "levant-cli";
  for (const m of plan.pending) {
    const batches = migrationBatches(m, by);
    if (!batches[0]!.atomic) warn(`${m.file}: runs without a wrapping transaction (${batches.length > 2 ? "large file, sent in parts" : "CONCURRENTLY / own BEGIN…COMMIT"})`);
    const t0 = Date.now();
    try {
      for (const b of batches) await runSql(client, p.ref, b.sql);
    } catch (e) {
      throw new CliError(`${m.file} failed${batches[0]!.atomic ? " (rolled back)" : ""}: ${(e as Error).message}`);
    }
    ok(`${m.file} ${c.dim(`${Date.now() - t0} ms`)}`);
  }
  await runSql(client, p.ref, "notify pgrst, 'reload schema'").catch(() => {});
  ok(`Applied ${plan.pending.length} migration${plan.pending.length === 1 ? "" : "s"}`);
}

export async function baseDbDump(client: Client, opts: Common & { file?: string; keep?: boolean }) {
  const p = await resolveBase(client, opts);
  info(c.dim(`Dumping ${p.name} (pg_dump of auth, public, storage and your schemas)…`));
  const { backup } = await client.request<{ backup: { id: string } }>("POST", P(p.ref, "/backups"));
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const r = await client.request<{ items: Array<{ id: string; status: string; error?: string | null }> }>("GET", P(p.ref, "/backups"));
    const b = r.items.find((x) => x.id === backup.id);
    if (b?.status === "SUCCEEDED") break;
    if (b && b.status !== "RUNNING") throw new CliError(`Dump failed: ${b.error ?? b.status}`);
    if (Date.now() > deadline) throw new CliError("Dump still running after 30 min");
    await new Promise((r) => setTimeout(r, 1500));
  }
  const res = await fetch(`${client.server}${P(p.ref, `/backups/${backup.id}/download`)}`, { headers: { authorization: `Bearer ${client.token}`, "user-agent": "levant-cli" } });
  if (!res.ok) throw new CliError(`Download failed (${res.status})`);
  const sql = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  if (opts.file) {
    fs.writeFileSync(opts.file, sql, { mode: 0o600 });
    ok(`Wrote ${opts.file} (${Math.round(sql.length / 1024)} KB)`);
  } else process.stdout.write(sql);
  info(c.dim(`  (kept as backup ${backup.id} in the dashboard)`));
}

export async function baseGenTypes(client: Client, lang: string, opts: Common & { schema?: string[] }) {
  if (lang !== "typescript") throw new CliError("Only `typescript` is supported");
  const p = await resolveBase(client, opts);
  const schemas = (opts.schema?.length ? opts.schema : ["public"]).join(",");
  const ts = await client.request<string>("GET", P(p.ref, "/types"), { query: { lang, schemas }, text: true });
  process.stdout.write(ts.endsWith("\n") ? ts : ts + "\n");
}

// ── functions ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Fn = { slug: string; name: string; verifyJwt: boolean; version: number; url: string; status?: string; updatedAt?: string };

export async function baseFunctionsLs(client: Client, opts: Common & { json?: boolean }) {
  const p = await resolveBase(client, opts);
  const r = await client.request<{ items: Fn[] }>("GET", P(p.ref, "/functions"));
  if (opts.json) return console.log(JSON.stringify(r.items, null, 2));
  if (!r.items.length) return info("No functions yet. Run `levant base functions deploy <slug>`.");
  table(
    r.items.map((f) => [f.slug, c.dim(`v${f.version}`), f.verifyJwt ? "JWT" : c.yellow("public"), f.url, c.dim(f.updatedAt ? timeAgo(f.updatedAt) : "")]),
    ["Slug", "Version", "Auth", "URL", "Deployed"],
  );
}

export async function baseFunctionsDeploy(client: Client, slugArg: string | undefined, opts: Common & { dir?: string; verifyJwt?: boolean; all?: boolean }) {
  const p = await resolveBase(client, opts);
  const root = path.join(supabaseDir(process.cwd()), "functions");
  const cfgFile = path.join(supabaseDir(process.cwd()), "config.toml");
  const cfg = fs.existsSync(cfgFile) ? functionsConfig(fs.readFileSync(cfgFile, "utf8")) : {};
  let targets: Array<{ slug: string; dir: string }>;
  if (slugArg) targets = [{ slug: slugArg, dir: path.resolve(opts.dir ?? path.join(root, slugArg)) }];
  else {
    if (!fs.existsSync(root)) throw new CliError(`Pass a function slug (no ${path.relative(process.cwd(), root)} folder here)`);
    targets = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .filter((e) => ["index.ts", "index.js", "index.tsx", "index.mjs"].some((f) => fs.existsSync(path.join(root, e.name, f))))
      .map((e) => ({ slug: e.name, dir: path.join(root, e.name) }));
    if (!targets.length) throw new CliError(`No functions in ${root}`);
    info(`Deploying ${targets.length} function${targets.length === 1 ? "" : "s"}: ${targets.map((t) => t.slug).join(", ")}`);
  }
  const existing = new Set((await client.request<{ items: Fn[] }>("GET", P(p.ref, "/functions"))).items.map((f) => f.slug));
  for (const t of targets) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(t.slug)) throw new CliError(`Invalid slug "${t.slug}" — lowercase letters, digits and dashes`);
    const b = bundleFunction(t.dir);
    for (const w of b.warnings) warn(`${t.slug}: ${w}`);
    const verifyJwt = opts.verifyJwt === false ? false : (cfg[t.slug]?.verifyJwt ?? true);
    const body = { code: b.code, verifyJwt, files: Object.keys(b.files).length ? b.files : undefined };
    const r = existing.has(t.slug)
      ? await client.request<{ function: Fn }>("PATCH", P(p.ref, `/functions/${t.slug}`), { body })
      : await client.request<{ function: Fn }>("POST", P(p.ref, "/functions"), { body: { slug: t.slug, ...body } });
    ok(`${t.slug} ${c.dim(`v${r.function.version}`)} ${verifyJwt ? "" : c.yellow("(no JWT verification) ")}→ ${c.cyan(r.function.url)}${b.shared.length ? c.dim(` (+${b.shared.length} _shared file${b.shared.length === 1 ? "" : "s"})`) : ""}`);
  }
}

export async function baseFunctionsRm(client: Client, slug: string, opts: Common) {
  const p = await resolveBase(client, opts);
  if (!opts.yes && isTTY() && !(await confirm(`Delete function ${c.bold(slug)} from ${p.name}?`, false))) return 130;
  await client.request("DELETE", P(p.ref, `/functions/${slug}`));
  ok(`Deleted ${slug}`);
}

export async function baseFunctionsInvoke(client: Client, slug: string, opts: Common & { data?: string; method?: string; service?: boolean; noAuth?: boolean }) {
  const p = await resolveBase(client, opts);
  const body = opts.data !== undefined ? opts.data : process.stdin.isTTY ? undefined : fs.readFileSync(0, "utf8");
  const r = await client.request<{ status: number; body: string; durationMs: number }>("POST", P(p.ref, `/functions/${slug}/invoke`), {
    body: { method: (opts.method ?? "POST").toUpperCase(), body, auth: opts.noAuth ? "none" : opts.service ? "service_role" : "anon" },
  });
  info(c.dim(`${r.status} · ${r.durationMs} ms`));
  process.stdout.write(r.body.endsWith("\n") ? r.body : r.body + "\n");
  return r.status >= 400 ? 1 : 0;
}

// ── secrets ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function baseSecretsLs(client: Client, opts: Common & { json?: boolean }) {
  const p = await resolveBase(client, opts);
  const r = await client.request<{ items: Array<{ name: string }> }>("GET", P(p.ref, "/secrets"));
  if (opts.json) return console.log(JSON.stringify(r.items.map((x) => x.name)));
  if (!r.items.length) return info("No secrets. Run `levant base secrets set KEY=value`.");
  for (const s of r.items) console.log(s.name);
  info(c.dim("\n  Values are write-only. Functions read them with Deno.env.get(\"NAME\")."));
}

export async function baseSecretsSet(client: Client, pairs: string[], opts: Common & { envFile?: string }) {
  const p = await resolveBase(client, opts);
  const set = { ...(opts.envFile ? parseEnvFile(fs.readFileSync(opts.envFile, "utf8")) : {}), ...parseKeyValues(pairs) };
  if (!Object.keys(set).length) throw new CliError("Pass KEY=value pairs or --env-file");
  await client.request("PUT", P(p.ref, "/secrets"), { body: { set } });
  ok(`Set ${Object.keys(set).join(", ")} ${c.dim("(the functions runtime restarts in a few seconds)")}`);
}

export async function baseSecretsUnset(client: Client, names: string[], opts: Common) {
  const p = await resolveBase(client, opts);
  await client.request("PUT", P(p.ref, "/secrets"), { body: { remove: names } });
  ok(`Removed ${names.join(", ")}`);
}

// ── studio ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function baseStudio(client: Client, opts: Common & { browser?: boolean }) {
  const p = await resolveBase(client, opts);
  let url: string;
  try {
    const r = await client.request<{ url: string; starting: boolean }>("POST", P(p.ref, "/studio"));
    url = r.url;
    if (r.starting) info(c.dim("Studio is starting — the page refreshes by itself."));
  } catch (e) {
    if (!(e instanceof CliError) || e.status !== 403) throw e;
    // Studio SSO links are only issued to dashboard sessions → open the project page, which has "Open Studio"
    const team = readBaseLink(process.cwd())?.teamSlug ?? (await teamSlug(client, opts.team));
    url = p.project ? `${client.server}/${team}/${p.project.slug}/backend` : `${client.server}/${team}/base/${p.ref}`;
    info(c.dim("Studio sign-in links are issued to dashboard sessions — opening the project page (click “Open Studio”)."));
  }
  console.log(url);
  if (opts.browser !== false) await open(url).catch(() => {});
}
