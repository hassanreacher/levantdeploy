import fs from "node:fs";
import path from "node:path";
import open from "open";
import { Client, CliError } from "../api.js";
import { resolveProject } from "../project.js";
import { logText, c, confirm, info, isTTY, ok, status, table, timeAgo } from "../ui.js";
import { streamLogs } from "../logs.js";
import type { Deployment } from "./deploy.js";

type Common = { project?: string; team?: string; yes?: boolean };

export async function ls(client: Client, opts: Common & { prod?: boolean; limit?: string }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const r = await client.request<{ items: Deployment[] }>("GET", `/api/v1/projects/${link.projectId}/deployments`, {
    query: { limit: Number(opts.limit) || 20, target: opts.prod ? "PRODUCTION" : undefined },
  });
  info(c.dim(`Deployments of ${link.teamSlug}/${link.projectSlug}\n`));
  if (!r.items.length) return info("No deployments yet. Run `levant deploy`.");
  table(
    r.items.map((d) => [
      c.dim(timeAgo(d.createdAt)),
      d.fullUrl,
      status(d.status),
      d.target === "PRODUCTION" ? (d.isCurrentProduction ? c.bold("Production ★") : "Production") : "Preview",
      c.dim(d.branch ?? ""),
    ]),
    ["Age", "Deployment", "Status", "Environment", "Branch"],
  );
}

/** Accepts a deployment id, short id, deployment URL/host, or a production URL (→ current production). */
export async function resolveDeployment(client: Client, ref: string | undefined, opts: Common = {}): Promise<Deployment> {
  if (!ref) {
    const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
    const r = await client.request<{ items: Deployment[] }>("GET", `/api/v1/projects/${link.projectId}/deployments`, { query: { limit: 1 } });
    if (!r.items[0]) throw new CliError("No deployments yet");
    return r.items[0];
  }
  let key = ref.trim();
  if (/^https?:\/\//.test(key)) key = new URL(key).hostname;
  const label = key.split(".")[0]!;
  const m = /-([a-z0-9]{9})$/.exec(label);
  const candidates = [key, ...(m ? [m[1]!] : [])];
  for (const id of candidates) {
    const d = await client.request<{ deployment: Deployment }>("GET", `/api/v1/deployments/${encodeURIComponent(id)}`).catch(() => null);
    if (d) return d.deployment;
  }
  if (key.includes(".")) {
    // production host → current production deployment of that project
    const projects = await client.request<{ items: Array<{ id: string; slug: string }> }>("GET", "/api/v1/projects", { query: { team: opts.team, q: label, limit: 100 } });
    const p = projects.items.find((x) => x.slug === label);
    if (p) {
      const r = await client.request<{ items: Deployment[] }>("GET", `/api/v1/projects/${p.id}/deployments`, { query: { target: "PRODUCTION", limit: 20 } });
      const cur = r.items.find((x) => x.isCurrentProduction) ?? r.items[0];
      if (cur) return cur;
    }
  }
  throw new CliError(`Deployment "${ref}" not found`);
}

export async function logs(client: Client, ref: string | undefined, opts: Common & { follow?: boolean; runtime?: boolean }) {
  const d = await resolveDeployment(client, ref, opts);
  info(c.dim(`${opts.runtime ? "Runtime" : "Build"} logs of ${d.fullUrl} (${d.status.toLowerCase()})\n`));
  const ctl = new AbortController();
  process.once("SIGINT", () => ctl.abort());
  await streamLogs(client, d.id, {
    stream: opts.runtime ? "RUNTIME" : "BUILD",
    follow: !!opts.follow,
    signal: ctl.signal,
    onLine: (l) => process.stdout.write(`${c.dim(new Date(l.ts).toISOString().replace("T", " ").slice(0, 19))}  ${logText(l.line, process.stdout)}\n`),
  });
}

export async function rollback(client: Client, ref: string | undefined, opts: Common) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  let target: Deployment;
  if (ref) target = await resolveDeployment(client, ref, opts);
  else {
    const r = await client.request<{ items: Deployment[] }>("GET", `/api/v1/projects/${link.projectId}/deployments`, { query: { target: "PRODUCTION", status: "READY,SUPERSEDED", limit: 20 } });
    const curIdx = r.items.findIndex((d) => d.isCurrentProduction);
    const prev = r.items.slice(curIdx + 1).find((d) => !d.isCurrentProduction);
    if (!prev) throw new CliError("No previous production deployment to roll back to");
    target = prev;
  }
  if (!opts.yes && isTTY() && !(await confirm(`Roll back production of ${link.projectSlug} to ${c.bold(target.fullUrl)} (#${target.number})?`))) return;
  await client.request("POST", `/api/v1/deployments/${target.id}/rollback`, { body: {} });
  ok(`Rolling back to #${target.number} ${c.dim(target.fullUrl)} — track it with \`levant ls\``);
}

export async function openCmd(client: Client, opts: Common & { dashboard?: boolean }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const r = await client.request<{ items: Array<{ id: string; productionUrl: string; dashboardUrl: string }> }>("GET", "/api/v1/projects", { query: { team: link.teamSlug, limit: 100 } });
  const p = r.items.find((x) => x.id === link.projectId);
  if (!p) throw new CliError("Linked project not found — run `levant link`");
  const url = opts.dashboard ? p.dashboardUrl : p.productionUrl;
  info(`Opening ${c.underline(url)}`);
  await open(url).catch(() => console.log(url));
}

// ───────────────────────────── env ─────────────────────────────

type EnvItem = { id: string; key: string; value: string | null; targets: string[]; isSecret: boolean; branch: string | null; updatedAt?: string };
const TARGETS: Record<string, string> = { production: "PRODUCTION", preview: "PREVIEW", development: "DEVELOPMENT" };
const parseTargets = (t?: string) =>
  (t ? t.split(",") : ["production", "preview", "development"]).map((x) => {
    const v = TARGETS[x.trim().toLowerCase()];
    if (!v) throw new CliError(`Unknown environment "${x}" (production, preview, development)`);
    return v;
  });

export async function envLs(client: Client, opts: Common) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const r = await client.request<{ items: EnvItem[] }>("GET", `/api/v1/projects/${link.projectId}/env`);
  if (!r.items.length) return info("No environment variables. Add one with `levant env add KEY value`.");
  table(
    r.items.map((e) => [e.key, e.isSecret ? c.dim("Encrypted (secret)") : c.dim("Encrypted"), e.targets.map((t) => t[0] + t.slice(1).toLowerCase()).join(", "), c.dim(e.branch ?? "")]),
    ["Name", "Value", "Environments", "Branch"],
  );
}

export async function envAdd(client: Client, key: string, value: string | undefined, opts: Common & { target?: string; secret?: boolean; branch?: string; force?: boolean }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  let v = value;
  if (v === undefined) {
    if (process.stdin.isTTY) throw new CliError("Pass the value as an argument or pipe it: echo -n value | levant env add KEY");
    v = fs.readFileSync(0, "utf8").replace(/\n$/, "");
  }
  await client.request("POST", `/api/v1/projects/${link.projectId}/env`, {
    body: { items: [{ key, value: v, targets: parseTargets(opts.target), isSecret: !!opts.secret, branch: opts.branch ?? null }], overwrite: !!opts.force },
  });
  ok(`Added ${c.bold(key)} to ${parseTargets(opts.target).map((t) => t.toLowerCase()).join(", ")}`);
}

export async function envRm(client: Client, key: string, opts: Common & { target?: string; yes?: boolean }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const r = await client.request<{ items: EnvItem[] }>("GET", `/api/v1/projects/${link.projectId}/env`);
  const want = opts.target ? parseTargets(opts.target) : null;
  const hits = r.items.filter((e) => e.key === key && (!want || e.targets.some((t) => want.includes(t))));
  if (!hits.length) throw new CliError(`${key} not found`);
  if (!opts.yes && isTTY() && !(await confirm(`Remove ${key} (${hits.length} entr${hits.length > 1 ? "ies" : "y"})?`))) return;
  for (const h of hits) await client.request("DELETE", `/api/v1/projects/${link.projectId}/env/${h.id}`);
  ok(`Removed ${c.bold(key)}`);
}

export async function envPull(client: Client, file: string | undefined, opts: Common & { environment?: string; yes?: boolean }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const target = parseTargets(opts.environment ?? "development")[0]!;
  const text = await client.request<string>("GET", `/api/v1/projects/${link.projectId}/env`, { query: { format: "dotenv", target }, text: true });
  const out = path.resolve(file ?? ".env.local");
  if (fs.existsSync(out) && !opts.yes && isTTY() && !(await confirm(`Overwrite ${path.basename(out)}?`))) return;
  fs.writeFileSync(out, `# Created by levant env pull (${target.toLowerCase()}) — do not commit\n${text}`, { mode: 0o600 });
  ok(`Wrote ${text.split("\n").filter((l) => l.includes("=")).length} variables to ${c.bold(path.relative(process.cwd(), out) || out)}`);
}

// ───────────────────────────── domains ─────────────────────────────

type Domain = { id: string; hostname: string; status: string; kind?: string; redirectTo?: string | null; gitBranch?: string | null; lastError?: string | null };

async function domainByName(client: Client, projectId: string, hostname: string) {
  const r = await client.request<{ items: Domain[] }>("GET", `/api/v1/projects/${projectId}/domains`);
  const d = r.items.find((x) => x.hostname === hostname.toLowerCase());
  if (!d) throw new CliError(`${hostname} is not a domain of this project`);
  return d;
}

export async function domainsLs(client: Client, opts: Common) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const r = await client.request<{ items: Domain[]; config?: { serverIps?: { ipv4?: string | null }; cnameTarget?: string } }>("GET", `/api/v1/projects/${link.projectId}/domains`);
  if (!r.items.length) info("No domains yet. Add one with `levant domains add example.com`.");
  else
    table(
      r.items.map((d) => [d.hostname, d.status === "ACTIVE" ? c.green(d.status) : d.status === "FAILED" ? c.red(d.status) : c.yellow(d.status), c.dim(d.redirectTo ? `→ ${d.redirectTo}` : (d.gitBranch ?? "")), c.dim(d.lastError ?? "")]),
      ["Domain", "Status", "", ""],
    );
  if (r.config?.cnameTarget || r.config?.serverIps?.ipv4) info(c.dim(`\nDNS: CNAME → ${r.config.cnameTarget ?? "?"}${r.config.serverIps?.ipv4 ? `  ·  A → ${r.config.serverIps.ipv4}` : ""}`));
}

export async function domainsAdd(client: Client, hostname: string, opts: Common & { redirect?: string; branch?: string }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  await client.request("POST", `/api/v1/projects/${link.projectId}/domains`, { body: { hostname, redirectTo: opts.redirect ?? null, gitBranch: opts.branch ?? null } });
  ok(`Added ${c.bold(hostname)}. Point its DNS to this server, then run \`levant domains verify ${hostname}\`.`);
}

export async function domainsRm(client: Client, hostname: string, opts: Common & { yes?: boolean }) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const d = await domainByName(client, link.projectId, hostname);
  if (!opts.yes && isTTY() && !(await confirm(`Remove ${hostname}?`))) return;
  await client.request("DELETE", `/api/v1/projects/${link.projectId}/domains/${d.id}`);
  ok(`Removed ${c.bold(hostname)}`);
}

export async function domainsVerify(client: Client, hostname: string, opts: Common) {
  const link = await resolveProject(client, process.cwd(), { ...opts, autoLink: false });
  const d = await domainByName(client, link.projectId, hostname);
  const r = await client.request<{ domain: Domain }>("POST", `/api/v1/projects/${link.projectId}/domains/${d.id}/verify`, { body: {} });
  if (r.domain.status === "ACTIVE") ok(`${hostname} is ${c.green("active")}`);
  else info(`${hostname}: ${c.yellow(r.domain.status)}${r.domain.lastError ? c.dim(` — ${r.domain.lastError}`) : ""}`);
}
