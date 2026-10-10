import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Deployment, Project } from "@prisma/client";
import { dockerNetwork, ensureNetwork, LABELS } from "@/lib/docker";
import { env } from "@/lib/env";
import { decryptJson } from "@/lib/crypto";
import { buildRuntimeEnv } from "./env";
import { EXTRA_LABELS, inspectSafe, removeContainer, type ContainerRef } from "./containers";
import { healthConfig } from "./settings";
import { HealthError, waitHealthy } from "./health";

/**
 * COMPOSE kind. Contract with the build area (Deployment.meta.compose):
 *   {
 *     file: "/abs/path/docker-compose.yml",          // compose file (in the work dir)
 *     projectDir?: "/abs/path",                       // default: dirname(file)
 *     services?: [{ name: "web", image?: "levant/…:tag", port?: 3000, public?: true }]
 *   }
 * `image` = an image the build area already built for a service with a `build:` section.
 * The runtime normalises the file with `docker compose config --format json`, then rewrites it:
 *   - drops host `ports` (traffic only through Caddy), joins levant_net with alias `ld-{shortId}-{service}`
 *   - adds levant labels + project env (LEVANT_* + user env; PORT only for the public service)
 *   - named volumes become stable per project: `levant_vol_{projectId}_{volume}` (data survives deploys)
 * and runs `docker compose -p levant_{shortId} -f <rewritten.json> up -d`. The routed service is the one marked
 * `public`, else the first with a published/exposed port, else the first service.
 * Files are kept in STORAGE_DIR/compose/{deploymentId}/ so restart/rollback work after the work dir is cleaned.
 */

export type ComposeMeta = { file: string; projectDir?: string; services?: Array<{ name: string; image?: string; port?: number; public?: boolean }> };

export const composeProjectName = (d: Pick<Deployment, "shortId">) => `levant_${d.shortId}`;
const composeDir = (d: Pick<Deployment, "id">) => path.resolve(env.STORAGE_DIR, "compose", d.id);
const composeFile = (d: Pick<Deployment, "id">) => path.join(composeDir(d), "levant-compose.json");

export function runCompose(args: string[], opts: { cwd?: string; onLine?: (l: string) => void; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["compose", ...args], { cwd: opts.cwd, env: { ...process.env, DOCKER_HOST: `unix://${env.DOCKER_SOCKET}` } });
    let out = "";
    let partial = "";
    const onData = (b: Buffer) => {
      const s = b.toString();
      out += s;
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
      if (opts.onLine) {
        partial += s;
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) opts.onLine(l);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 15 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (partial.trim() && opts.onLine) opts.onLine(partial);
      resolve({ code: code ?? 1, out });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: String(e) });
    });
  });
}

type NormalizedService = {
  image?: string;
  build?: unknown;
  ports?: Array<{ target?: number; published?: string | number }>;
  expose?: Array<string | number>;
  networks?: Record<string, unknown>;
  labels?: Record<string, string>;
  environment?: Record<string, string | null>;
  volumes?: Array<{ type?: string; source?: string; target?: string }>;
  container_name?: string;
  network_mode?: string;
  [k: string]: unknown;
};
type NormalizedConfig = { name?: string; services: Record<string, NormalizedService>; volumes?: Record<string, Record<string, unknown> | null>; networks?: Record<string, unknown>; [k: string]: unknown };

/** Pure rewrite (tested): normalised compose config → LevantDeploy compose config + routed service info. */
export function rewriteCompose(
  cfg: NormalizedConfig,
  input: { shortId: string; projectId: string; deploymentId: string; teamId: string; network: string; env: Record<string, string>; meta: ComposeMeta; defaultPort: number },
): { config: NormalizedConfig; publicService: string; publicPort: number; services: string[] } {
  const names = Object.keys(cfg.services ?? {});
  if (!names.length) throw new Error("docker-compose file has no services");
  const metaSvc = new Map((input.meta.services ?? []).map((s) => [s.name, s]));
  const portOf = (name: string): number | null => {
    const s = cfg.services[name]!;
    const m = metaSvc.get(name)?.port;
    if (m) return m;
    const p = s.ports?.find((x) => x.target)?.target;
    if (p) return Number(p);
    const e = s.expose?.[0];
    if (e !== undefined) return Number(String(e).split("/")[0]);
    return null;
  };
  const publicService =
    (input.meta.services ?? []).find((s) => s.public && names.includes(s.name))?.name ?? names.find((n) => portOf(n) !== null) ?? names[0]!;
  const publicPort = portOf(publicService) ?? input.defaultPort;

  const out: NormalizedConfig = JSON.parse(JSON.stringify(cfg));
  out.name = `levant_${input.shortId}`;
  const { PORT: _port, HOST: _h, HOSTNAME: _hn, ...sharedEnv } = input.env;
  for (const name of names) {
    const s = out.services[name]!;
    delete s.ports;
    delete s.container_name; // names must be unique per deployment
    const img = metaSvc.get(name)?.image;
    if (img) {
      s.image = img;
      delete s.build;
    }
    if (s.network_mode) continue; // e.g. network_mode: service:x
    const nets = (s.networks && typeof s.networks === "object" ? s.networks : {}) as Record<string, unknown>;
    if (!Object.keys(nets).length) nets.default = null;
    nets[input.network] = { aliases: [`ld-${input.shortId}-${name}`] };
    s.networks = nets;
    s.labels = {
      ...(s.labels ?? {}),
      [LABELS.managed]: "true",
      [LABELS.team]: input.teamId,
      [LABELS.project]: input.projectId,
      [LABELS.deployment]: input.deploymentId,
      [LABELS.kind]: "COMPOSE",
      [EXTRA_LABELS.role]: "compose",
      [EXTRA_LABELS.service]: name,
    };
    const envForSvc: Record<string, string | null> = { ...sharedEnv, ...(s.environment ?? {}) };
    if (name === publicService) envForSvc.PORT ??= String(publicPort);
    s.environment = envForSvc;
    if (!s.restart) s.restart = "unless-stopped";
    s.logging ??= { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } };
  }
  out.networks = { ...(out.networks ?? {}), [input.network]: { name: input.network, external: true } };
  if (out.networks.default === undefined) out.networks.default = { name: `levant_${input.shortId}_default` };
  // stable named volumes per project
  for (const [vname, vcfg] of Object.entries(out.volumes ?? {})) {
    const c = (vcfg ?? {}) as Record<string, unknown>;
    if (c.external) continue;
    out.volumes![vname] = { ...c, name: `levant_vol_${input.projectId}_${vname}`, labels: { [LABELS.managed]: "true", [LABELS.project]: input.projectId } };
  }
  return { config: out, publicService, publicPort, services: names };
}

/** Normalised compose spec of a deployment: build area's encrypted spec (preferred) or meta.compose.file. */
async function loadComposeSpec(dep: Deployment): Promise<{ cfg: NormalizedConfig; meta: ComposeMeta; projectDir: string }> {
  const m = (dep.meta ?? {}) as Record<string, unknown>;
  const build = (m.build ?? {}) as { composeSpecEnc?: string; composePrimary?: string; port?: number; compose?: Array<{ name: string; image: string; ports?: number[] }> };
  if (build.composeSpecEnc) {
    const cfg = decryptJson<NormalizedConfig>(build.composeSpecEnc);
    if (!cfg?.services) throw new Error("Cannot decrypt the compose spec of this deployment");
    const meta: ComposeMeta = {
      file: "",
      services: (build.compose ?? []).map((s) => ({
        name: s.name,
        image: s.image,
        port: s.name === build.composePrimary ? (build.port ?? s.ports?.[0]) : s.ports?.[0],
        public: s.name === build.composePrimary,
      })),
    };
    if (build.composePrimary && !meta.services!.some((s) => s.public)) meta.services!.push({ name: build.composePrimary, public: true, port: build.port });
    return { cfg, meta, projectDir: composeDir(dep) };
  }
  const meta = (m.compose ?? null) as ComposeMeta | null;
  if (!meta?.file) throw new Error("COMPOSE deployment has no compose spec (meta.build.composeSpecEnc / meta.compose.file)");
  const projectDir = meta.projectDir ?? path.dirname(meta.file);
  const cfgRes = await runCompose(["-f", meta.file, "--project-directory", projectDir, "config", "--format", "json"], { cwd: projectDir });
  if (cfgRes.code !== 0) throw new Error(`docker compose config failed:\n${cfgRes.out.slice(-2000)}`);
  return { cfg: JSON.parse(cfgRes.out.slice(cfgRes.out.indexOf("{"))) as NormalizedConfig, meta, projectDir };
}

export async function startCompose(project: Project, dep: Deployment, log: (l: string | string[]) => Promise<void>): Promise<ContainerRef[]> {
  await ensureNetwork();
  await fs.promises.mkdir(composeDir(dep), { recursive: true, mode: 0o700 });
  const { cfg: normalized, meta, projectDir } = await loadComposeSpec(dep);
  const runtimeEnv = await buildRuntimeEnv(project, dep);
  const { config, publicService, publicPort, services } = rewriteCompose(normalized, {
    shortId: dep.shortId,
    projectId: project.id,
    deploymentId: dep.id,
    teamId: project.teamId,
    network: dockerNetwork(),
    env: runtimeEnv,
    meta,
    defaultPort: project.port,
  });
  await fs.promises.mkdir(composeDir(dep), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(composeFile(dep), JSON.stringify(config, null, 2), { mode: 0o600 });
  await log(`Compose project ${composeProjectName(dep)}: services ${services.join(", ")} (public: ${publicService}:${publicPort})`);
  const needsBuild = Object.values(config.services).some((s) => s.build && !s.image);
  const up = await runCompose(
    ["-p", composeProjectName(dep), "-f", composeFile(dep), "--project-directory", projectDir, "up", "-d", "--remove-orphans", needsBuild ? "--build" : "--no-build"],
    { cwd: projectDir, onLine: (l) => void log(`  ${l}`) },
  );
  if (up.code !== 0) {
    await composeDown(dep).catch(() => {});
    throw new Error(`docker compose up failed (exit ${up.code})`);
  }
  const refs = await composeRefs(dep, publicService, publicPort);
  const pub = refs.find((r) => r.public);
  if (!pub) throw new Error(`Service ${publicService} did not start`);
  try {
    const r = await waitHealthy(pub, healthConfig(project), { onLog: (l) => void log(l), isCanceled: async () => false });
    await log(`Service ${publicService} healthy in ${(r.ms / 1000).toFixed(1)}s`);
    for (const ref of refs.filter((x) => !x.public)) {
      const info = await inspectSafe(ref.id);
      if (info && !info.State.Running && info.State.ExitCode !== 0) throw new HealthError(`Service ${ref.service} exited with code ${info.State.ExitCode}`, "");
    }
  } catch (e) {
    await composeDown(dep).catch(() => {});
    throw Object.assign(new Error((e as Error).message), { logs: (e as HealthError).logs });
  }
  return refs;
}

async function composeRefs(dep: Deployment, publicService: string, publicPort: number): Promise<ContainerRef[]> {
  const { docker } = await import("@/lib/docker");
  const list = await docker().listContainers({ all: true, filters: { label: [`com.docker.compose.project=${composeProjectName(dep)}`] } });
  return list.map((c) => {
    const service = c.Labels["com.docker.compose.service"] ?? "app";
    const n = Number(c.Labels["com.docker.compose.container-number"] ?? 1);
    return {
      id: c.Id,
      name: (c.Names[0] ?? "").replace(/^\//, ""),
      replica: n,
      port: service === publicService ? publicPort : 0,
      alias: `ld-${dep.shortId}-${service}`,
      service,
      public: service === publicService && n === 1,
    } satisfies ContainerRef;
  });
}

async function composeCmd(dep: Deployment, args: string[]) {
  const f = composeFile(dep);
  if (!fs.existsSync(f)) return { code: 1, out: "compose file missing" };
  return runCompose(["-p", composeProjectName(dep), "-f", f, ...args]);
}

export const composeStop = (dep: Deployment) => composeCmd(dep, ["stop"]);
export const composeStart = (dep: Deployment) => composeCmd(dep, ["start"]);

/** Remove the stack (containers + default network). Named volumes are kept (they belong to the project). */
export async function composeDown(dep: Deployment) {
  const r = await composeCmd(dep, ["down", "--remove-orphans"]);
  if (r.code !== 0) {
    const { docker } = await import("@/lib/docker");
    const list = await docker().listContainers({ all: true, filters: { label: [`com.docker.compose.project=${composeProjectName(dep)}`] } });
    for (const c of list) await removeContainer(c.Id).catch(() => {});
  }
  await fs.promises.rm(composeDir(dep), { recursive: true, force: true }).catch(() => {});
}
