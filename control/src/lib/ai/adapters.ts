import dns from "node:dns/promises";
import type { Deployment, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { docker, LABELS } from "@/lib/docker";

/**
 * Adapters to other areas' libraries (build / runtime / domains), loaded with dynamic imports so the AI
 * area builds and runs even when those libs don't exist yet (wave B is parallel). Every adapter falls back
 * to foundation-level behaviour or returns `{ supported: false }` with a reason the agent can relay.
 *
 * Probed modules (first existing export wins — see `docs/requests/ai.md` for the contract we rely on):
 *   runtime:   src/lib/runtime/deploy.ts        restartDeployment(deploymentId) · rollbackTo(deploymentId, userId)
 *   databases: src/lib/runtime/databases.ts     createDatabase | provisionDatabase (input object)
 *   domains:   src/lib/domains/index.ts         checkDomainDns | checkDomain | verifyDomain (domainId) · addDomain | createDomain (input object)
 *   build:     src/lib/build/detect.ts          detect(dir, settings) + src/lib/build/dockerfile.ts generateDockerfile({ detection, settings })
 */
type AnyFn = (...args: unknown[]) => unknown;
type Mod = Record<string, unknown>;

const cache = new Map<string, Promise<Mod | null>>();

async function load(path: string): Promise<Mod | null> {
  if (!cache.has(path)) {
    cache.set(
      path,
      (async () => {
        try {
          return (await import(
            /* webpackInclude: /[\\/](runtime|domains|build)[\\/](index|deploy|databases|domains|dockerfile|detect)\.ts$/ */
            /* webpackExclude: /\.test\.ts$/ */
            `@/lib/${path}`
          )) as Mod;
        } catch {
          return null;
        }
      })(),
    );
  }
  return cache.get(path)!;
}

/** First function named in `names` exported by any of `paths`. */
export async function findExport(paths: string[], names: string[]): Promise<{ fn: AnyFn; where: string } | null> {
  for (const p of paths) {
    const m = await load(p);
    if (!m) continue;
    for (const n of names) if (typeof m[n] === "function") return { fn: m[n] as AnyFn, where: `${p}#${n}` };
  }
  return null;
}

export type AdapterResult<T = unknown> = { supported: true; via: string; result: T } | { supported: false; reason: string };

const unsupported = (what: string): AdapterResult<never> => ({
  supported: false,
  reason: `${what} isn't available on this installation yet (the runtime/build module doesn't expose it). Tell the user to do it from the dashboard.`,
});

// ───────────────────────────── runtime ─────────────────────────────

/** Restart the running containers of a deployment (runtime lib, else `docker restart` by label). */
export async function restartDeployment(d: Deployment): Promise<AdapterResult> {
  const ext = await findExport(["runtime/deploy", "runtime/index"], ["restartDeployment"]);
  if (ext) return { supported: true, via: ext.where, result: (await ext.fn(d.id)) ?? { restarted: true } };
  try {
    const list = await docker().listContainers({ all: true, filters: { label: [`${LABELS.deployment}=${d.id}`] } });
    if (!list.length) return { supported: false, reason: "No containers found for this deployment (is it running?)" };
    for (const c of list) await docker().getContainer(c.Id).restart({ t: 10 });
    return { supported: true, via: "docker", result: { restarted: list.map((c) => c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12)) } };
  } catch (e) {
    return { supported: false, reason: `Docker is not reachable: ${(e as Error).message}` };
  }
}

/** Point production back at an earlier READY/SUPERSEDED deployment (runtime lib only). */
export async function rollbackTo(project: Project, d: Deployment, userId: string): Promise<AdapterResult> {
  const ext = await findExport(["runtime/deploy", "runtime/index"], ["rollbackTo", "rollbackDeployment"]);
  if (!ext) return unsupported("Rollback");
  void project;
  return { supported: true, via: ext.where, result: (await ext.fn(d.id, userId)) ?? { restored: d.number } };
}

export async function createDatabase(input: { teamId: string; projectId: string; engine: string; name: string; version?: string; userId: string }): Promise<AdapterResult> {
  const ext = await findExport(["runtime/databases", "runtime/index"], ["createDatabase", "provisionDatabase"]);
  if (!ext) return unsupported("Creating databases");
  return { supported: true, via: ext.where, result: await ext.fn(input) };
}

// ───────────────────────────── domains ─────────────────────────────

export type DnsReport = {
  hostname: string;
  a: string[];
  aaaa: string[];
  cname: string[];
  txt: string[];
  verifyTxt: string[];
  expected: { a: string[]; cname: string | null; verifyToken: string | null };
  pointsToPlatform: boolean;
  verified: boolean;
  errors: string[];
};

async function safe<T>(p: Promise<T>, errors: string[], label: string, empty: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENODATA" && code !== "ENOTFOUND") errors.push(`${label}: ${code ?? (e as Error).message}`);
    return empty;
  }
}

/** IPv4 addresses custom domains should point at (Server.host if it's an IP, else the dashboard host's A records). */
export async function platformAddresses(): Promise<string[]> {
  const server = await db.server.findFirst({ where: { isLocal: true }, select: { host: true } }).catch(() => null);
  if (server?.host && /^\d+\.\d+\.\d+\.\d+$/.test(server.host)) return [server.host];
  const host = (process.env.DASHBOARD_HOST || "").split(":")[0];
  if (!host || host === "localhost") return [];
  return dns.resolve4(host).catch(() => []);
}

/** DNS check for a hostname (domains lib if present, else live DNS lookups). */
export async function checkDomainDns(hostname: string, opts: { projectSlug?: string; verifyToken?: string | null } = {}): Promise<AdapterResult<unknown>> {
  const domainRow = await db.domain.findUnique({ where: { hostname } }).catch(() => null);
  const ext = await findExport(["domains/index"], ["checkDomainDns", "checkDomain", "verifyDomain"]);
  if (ext && domainRow) {
    try {
      return { supported: true, via: ext.where, result: await ext.fn(domainRow.id) };
    } catch {
      /* fall through to plain DNS */
    }
  }
  const errors: string[] = [];
  const [a, aaaa, cname, txt, verifyTxt, expectedA] = await Promise.all([
    safe(dns.resolve4(hostname), errors, "A", [] as string[]),
    safe(dns.resolve6(hostname), errors, "AAAA", [] as string[]),
    safe(dns.resolveCname(hostname), errors, "CNAME", [] as string[]),
    safe(dns.resolveTxt(hostname).then((r) => r.map((x) => x.join(""))), errors, "TXT", [] as string[]),
    safe(dns.resolveTxt(`_levant-verify.${hostname}`).then((r) => r.map((x) => x.join(""))), errors, "TXT _levant-verify", [] as string[]),
    platformAddresses(),
  ]);
  const platform = (process.env.PLATFORM_DOMAIN || "").toLowerCase();
  const cnameTarget = opts.projectSlug && platform ? `${opts.projectSlug}.${platform}` : null;
  const token = opts.verifyToken ?? domainRow?.verifyToken ?? null;
  const report: DnsReport = {
    hostname,
    a,
    aaaa,
    cname,
    txt: txt.slice(0, 10),
    verifyTxt,
    expected: { a: expectedA, cname: cnameTarget, verifyToken: token },
    pointsToPlatform: (expectedA.length > 0 && a.some((x) => expectedA.includes(x))) || (!!cnameTarget && cname.some((c) => c.replace(/\.$/, "") === cnameTarget)),
    verified: !!token && verifyTxt.includes(token),
    errors,
  };
  return { supported: true, via: "dns", result: report };
}

/** Add a custom domain (domains lib if present, else a PENDING Domain row + `domains` check job). */
export async function addDomain(input: { projectId: string; hostname: string; redirectTo?: string | null; gitBranch?: string | null; userId: string }): Promise<AdapterResult> {
  const ext = await findExport(["domains/index"], ["addDomain", "createDomain"]);
  if (ext) return { supported: true, via: ext.where, result: await ext.fn(input) };
  const { randomToken } = await import("@/lib/crypto");
  const { queues } = await import("@/lib/queues");
  const existing = await db.domain.findUnique({ where: { hostname: input.hostname } });
  if (existing) return { supported: false, reason: `${input.hostname} is already attached to a project` };
  const row = await db.domain.create({
    data: {
      projectId: input.projectId,
      hostname: input.hostname,
      kind: "CUSTOM",
      status: "PENDING",
      verifyToken: `levant-${randomToken(16)}`,
      redirectTo: input.redirectTo ?? null,
      redirectStatus: input.redirectTo ? 308 : null,
      gitBranch: input.gitBranch ?? null,
    },
  });
  await queues.domains.add({ domainId: row.id }).catch(() => {});
  return { supported: true, via: "db", result: { id: row.id, hostname: row.hostname, status: row.status, verifyToken: row.verifyToken } };
}

// ───────────────────────────── build ─────────────────────────────

/** Dockerfile from the build area's detector + templates (needs the source snapshot dir); null when unavailable. */
export async function buildAreaDockerfile(project: Project, sourceDir: string | null): Promise<{ dockerfile: string; framework?: string; via: string } | null> {
  if (!sourceDir) return null;
  const det = await findExport(["build/detect"], ["detect"]);
  const gen = await findExport(["build/dockerfile"], ["generateDockerfile"]);
  if (!det || !gen) return null;
  try {
    const settings = (project.buildSettings as Record<string, unknown>) ?? {};
    const detection = (await det.fn(sourceDir, settings)) as { framework?: string } | null;
    if (!detection) return null;
    const out = (await gen.fn({ detection, settings })) as { dockerfile?: unknown } | null;
    if (out && typeof out.dockerfile === "string") return { dockerfile: out.dockerfile, framework: detection.framework, via: gen.where };
  } catch {
    /* e.g. the detection says "use the repo Dockerfile" → fall back to our templates */
  }
  return null;
}

/** Whether the build engine honours `buildSettings.dockerfileInline` (see docs/requests/ai.md). */
export async function buildSupportsInlineDockerfile(): Promise<boolean> {
  for (const p of ["build/index", "build/dockerfile", "build/detect"]) {
    const m = await load(p);
    if (m && (m["SUPPORTS_DOCKERFILE_INLINE"] === true || typeof m["resolveDockerfileInline"] === "function")) return true;
  }
  return false;
}
