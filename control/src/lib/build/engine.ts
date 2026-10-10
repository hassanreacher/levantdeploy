import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Deployment, Prisma, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { newRedis } from "@/lib/redis";
import { encryptJson } from "@/lib/crypto";
import { LABELS } from "@/lib/docker";
import { endLogs, archiveLogs } from "@/lib/logs";
import { getSetting } from "@/lib/settings";
import { queues } from "@/lib/queues";
import { setStatus, isCancelRequested, TransitionError } from "@/lib/deployments";
import { fetchSource, cleanupWorkDir, workDirFor, type FetchedSource } from "@/lib/sources";
import { detect } from "./detect";
import { generateDockerfile, DEFAULT_DOCKERIGNORE } from "./dockerfile";
import { dockerBuild, dockerPull, getBuildProxy, imageExists, imageInfo, type BuildProxy } from "./docker-build";
import { composeConfig, primaryService, resolveBuildContext, runtimeSpec, servicePorts } from "./compose";
import { resolveEnv, RESERVED_BUILD_KEYS } from "./env";
import { BuildLog, summarizeError } from "./log";
import { parseBuildSettings, type BuildMeta, type ComposeServiceMeta, type Detection } from "./types";

/**
 * The build pipeline for one deployment:
 *   QUEUED → BUILDING → fetch source → detect → (Dockerfile | generated template | compose services | image) → docker build
 *          → DEPLOYING {imageTag, meta.build} + queues.deploy.add   — or ERROR {errorStep, errorMessage}
 * BUILD logs are always ended + archived; the work dir is always removed.
 *
 *   await buildDeployment(deploymentId)                       // worker + tests
 *   await buildDeployment(id, { enqueueDeploy: false })       // build only (scripts/build-examples.ts)
 */

export type BuildOutcome =
  | { status: "DEPLOYING"; imageTag: string; meta: BuildMeta; durationMs: number }
  | { status: "ERROR"; errorStep: string; errorMessage: string; durationMs: number }
  | { status: "CANCELED" | "SKIPPED"; reason: string; durationMs: number };

export type BuildRunOptions = {
  /** default true: enqueue the deploy job after a successful build */
  enqueueDeploy?: boolean;
  signal?: AbortSignal;
  /** keep the work dir (debugging) */
  keepWorkDir?: boolean;
  /** override the timeout setting */
  timeoutMs?: number;
};

class StepError extends Error {
  constructor(
    public step: string,
    message: string,
    public tail?: string[],
  ) {
    super(message);
  }
}
class CanceledError extends Error {}

export const imageRepo = (projectId: string) => `levant/${projectId.toLowerCase().replace(/[^a-z0-9_.-]/g, "")}`;
export const imageTagFor = (projectId: string, shortId: string, service?: string) =>
  `${imageRepo(projectId)}:${shortId}${service ? `-${service.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}` : ""}`.slice(0, 200);

export async function buildDeployment(deploymentId: string, opts: BuildRunOptions = {}): Promise<BuildOutcome> {
  const started = Date.now();
  const dep = await db.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
  if (!dep) return { status: "SKIPPED", reason: "deployment not found", durationMs: 0 };
  if (dep.status !== "QUEUED") return { status: "SKIPPED", reason: `deployment is ${dep.status}`, durationMs: 0 };

  const log = new BuildLog(dep.id);
  const ac = new AbortController();
  const outer = opts.signal;
  const onOuter = () => ac.abort();
  outer?.addEventListener("abort", onOuter, { once: true });

  // cancellation: pub/sub (instant) + polling (fallback)
  const sub = newRedis();
  let canceled = false;
  const markCanceled = () => {
    if (!canceled) {
      canceled = true;
      ac.abort();
    }
  };
  await sub.subscribe("ld:cancel").catch(() => {});
  sub.on("message", (_ch, id) => id === dep.id && markCanceled());
  const poll = setInterval(() => void isCancelRequested(dep.id).then((c) => c && markCanceled()).catch(() => {}), 3000);

  try {
    try {
      await setStatus(dep.id, "BUILDING", { message: "Build started" });
    } catch (e) {
      if (e instanceof TransitionError) return { status: "SKIPPED", reason: e.message, durationMs: Date.now() - started };
      throw e;
    }
    const timeoutMs = opts.timeoutMs ?? (await getSetting("build.timeoutMinutes")) * 60_000;
    const deadline = started + timeoutMs;
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
    timer.unref();
    try {
      const res = await runBuild(dep, dep.project, log, ac.signal, deadline);
      if (canceled || (await isCancelRequested(dep.id))) throw new CanceledError("canceled");
      const durationMs = Date.now() - started;
      const meta: BuildMeta = { ...res.meta, durationMs };
      log.success(`Build completed in ${fmtDuration(durationMs)}`);
      await log.flush();
      try {
        await setStatus(dep.id, "DEPLOYING", {
          imageTag: res.imageTag,
          message: "Build completed",
          meta: { build: meta as unknown as Prisma.InputJsonObject },
        });
      } catch (e) {
        if (e instanceof TransitionError) return { status: "CANCELED", reason: e.message, durationMs };
        throw e;
      }
      await db.deployment.update({ where: { id: dep.id }, data: { framework: meta.framework } }).catch(() => {});
      await syncProjectFromBuild(dep.project, meta);
      if (opts.enqueueDeploy !== false) await queues.deploy.add({ deploymentId: dep.id });
      return { status: "DEPLOYING", imageTag: res.imageTag, meta, durationMs };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const durationMs = Date.now() - started;
    const timedOut = ac.signal.reason instanceof Error && ac.signal.reason.message === "timeout";
    if (canceled || e instanceof CanceledError) {
      log.warn("Build canceled.");
      await log.flush();
      // cancelDeployment() already moved the row to CANCELED; make sure of it (e.g. canceled through ld:cancel only)
      await setStatus(dep.id, "CANCELED", { message: "Build canceled" }).catch(() => {});
      return { status: "CANCELED", reason: "canceled", durationMs };
    }
    const step = timedOut ? "BUILD" : e instanceof StepError ? e.step : "BUILD";
    const errorMessage = timedOut
      ? `Build timed out after ${Math.round((opts.timeoutMs ?? (await getSetting("build.timeoutMinutes")) * 60_000) / 60_000)} minutes`
      : e instanceof StepError
        ? e.message
        : `Build failed: ${(e as Error).message}`;
    log.error(errorMessage.split("\n")[0]!);
    await log.flush();
    await setStatus(dep.id, "ERROR", { errorStep: step, errorMessage }).catch((err) => {
      if (!(err instanceof TransitionError)) console.warn("[build] setStatus ERROR failed", (err as Error).message);
    });
    return { status: "ERROR", errorStep: step, errorMessage, durationMs };
  } finally {
    clearInterval(poll);
    outer?.removeEventListener("abort", onOuter);
    sub.disconnect();
    await log.flush();
    await endLogs(dep.id, "BUILD").catch(() => {});
    await archiveLogs(dep.id, "BUILD").catch((e) => console.warn("[build] archiveLogs failed", (e as Error).message));
    if (!opts.keepWorkDir && process.env.LEVANT_KEEP_WORKDIR !== "1") await cleanupWorkDir(dep.id);
  }
}

type DepWithProject = Deployment & { project: Project };

async function runBuild(dep: DepWithProject, project: Project, log: BuildLog, signal: AbortSignal, deadline: number): Promise<{ imageTag: string; meta: BuildMeta }> {
  const left = () => Math.max(1000, deadline - Date.now());
  const check = () => {
    if (signal.aborted) throw signal.reason instanceof Error && signal.reason.message === "timeout" ? signal.reason : new CanceledError("canceled");
  };
  const settings = parseBuildSettings(project.buildSettings);
  const proxy = await getBuildProxy();

  // ── 1. source ──
  log.step(project.sourceType === "IMAGE" ? "Resolving image…" : project.sourceType === "UPLOAD" || dep.uploadId ? "Fetching uploaded source…" : "Cloning…");
  let src: FetchedSource;
  try {
    src = await fetchSource(dep, project, { log: (l) => log.info(l), signal, timeoutMs: Math.min(left(), 15 * 60_000) });
  } catch (e) {
    check();
    throw new StepError("SOURCE", `Could not fetch the source: ${(e as Error).message}`);
  }
  check();
  if (src.kind === "git" && src.commitSha && (!dep.commitSha || !dep.commitMessage || !dep.commitAuthor)) {
    // record what was actually built (Deploy button / API deployments only know the branch)
    await db.deployment
      .update({
        where: { id: dep.id },
        data: {
          commitSha: dep.commitSha ?? src.commitSha,
          commitMessage: dep.commitMessage ?? src.commitMessage?.slice(0, 2000) ?? null,
          commitAuthor: dep.commitAuthor ?? src.commitAuthor ?? null,
        },
      })
      .catch(() => {});
    dep.commitSha = dep.commitSha ?? src.commitSha;
  }

  // ── IMAGE source: nothing to build ──
  if (src.kind === "image") {
    const image = src.image!;
    log.step(`Pulling ${image}…`);
    const r = await dockerPull(image, (l) => log.info(l), signal, left());
    check();
    if (r.code !== 0) {
      if (await imageExists(image)) log.warn(`Pull failed, using the local copy of ${image}`);
      else throw new StepError("SOURCE", `Could not pull ${image}: ${summarizeError(r.tail, "docker pull failed")}`);
    }
    const info = await imageInfo(image);
    log.success(`Using prebuilt image ${image}${info ? ` (${fmtBytes(info.size)})` : ""} — build skipped`);
    return {
      imageTag: image,
      meta: { framework: "image", frameworkName: "Docker image", kind: project.kind, strategy: "image", port: info?.exposedPorts[0] ?? project.port, exposedPorts: info?.exposedPorts, imageTag: image, imageSize: info?.size },
    };
  }

  // ── 2. detect ──
  log.step("Detecting framework…");
  let d: Detection;
  try {
    d = detect(src.contextDir, settings, { repoDir: src.repoDir });
  } catch (e) {
    throw new StepError("DETECT", `Framework detection failed: ${(e as Error).message}`);
  }
  log.info(`Detected ${describe(d)}`);
  for (const n of d.notes) log.info(n);
  if (d.overridden.length) log.info(`Project settings override: ${d.overridden.join(", ")}`);
  if (d.framework === "unknown") throw new StepError("DETECT", d.notes[0] ?? "Could not detect how to build this project");

  // ── 3. env ──
  const vars = await resolveEnv(dep, project);
  const buildArgs: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const v of vars) {
    if (RESERVED_BUILD_KEYS.has(v.key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) continue;
    if (v.isSecret) secrets[v.key] = v.value;
    else buildArgs[v.key] = v.value;
  }
  for (const [k, v] of Object.entries(settings.buildArgs ?? {})) buildArgs[k] = v;
  const userVarCount = vars.filter((v) => v.source !== "system").length;
  log.info(`Environment: ${userVarCount} variable${userVarCount === 1 ? "" : "s"} for ${dep.target.toLowerCase()} (${Object.keys(secrets).length} secret, passed as BuildKit secrets) + LEVANT_* system variables`);
  if (proxy) log.info(`Build proxy enabled${proxy.httpsProxy ? ` (${redactUrl(proxy.httpsProxy)})` : ""}${proxy.caCertPem ? " + custom CA" : ""}${proxy.network === "host" ? ", host network" : ""}`);

  const work = workDirFor(dep.id);
  const tag = imageTagFor(project.id, dep.shortId);
  const labels = {
    [LABELS.managed]: "true",
    [LABELS.project]: project.id,
    [LABELS.deployment]: dep.id,
    [LABELS.team]: project.teamId,
    "levant.framework": d.framework,
  };
  // redeploy "without build cache": --no-cache and no cache-from
  const noCache = (dep.meta as Record<string, unknown> | null)?.noCache === true;
  const cacheFrom = noCache ? [] : await previousImages(project.id, dep.id);
  if (noCache) log.info("Build cache disabled for this deployment (--no-cache)");
  const common = { proxy, tmpDir: work, signal, labels, cacheFrom, noCache };

  // ── 4a. compose ──
  if (d.strategy === "compose") return buildCompose(dep, project, d, src, log, { ...common, buildArgs, secrets, left, check });

  // ── 4b. Dockerfile (repo) or generated ──
  let dockerfile: string;
  let contextDir = src.contextDir;
  if (d.strategy === "dockerfile" && d.meta.inline && settings.dockerfileInline) {
    dockerfile = path.join(work, "Dockerfile.inline");
    await fsp.writeFile(dockerfile, settings.dockerfileInline);
    log.step("Building image from the inline Dockerfile (project settings)…");
  } else if (d.strategy === "dockerfile") {
    dockerfile = path.resolve(src.contextDir, d.dockerfilePath ?? "Dockerfile");
    if (!dockerfile.startsWith(path.resolve(src.repoDir) + path.sep) || !fs.existsSync(dockerfile))
      throw new StepError("DETECT", `Dockerfile not found at ${d.dockerfilePath ?? "Dockerfile"}`);
    log.step(`Building image from ${path.relative(src.repoDir, dockerfile)}…`);
  } else {
    let appDir = "";
    if (typeof d.meta.workspaceRoot === "string" && d.meta.workspaceRoot) {
      const ws = path.resolve(src.contextDir, d.meta.workspaceRoot);
      if (ws.startsWith(path.resolve(src.repoDir))) {
        contextDir = ws;
        appDir = path.relative(ws, src.contextDir).split(path.sep).join("/");
      }
    }
    let gen;
    try {
      const registryMirror = await getSetting("build.registryMirror");
      gen = generateDockerfile({ detection: d, settings, buildArgKeys: Object.keys(buildArgs), secretKeys: Object.keys(secrets), cacheKey: project.id, appDir, registryMirror });
    } catch (e) {
      throw new StepError("DETECT", (e as Error).message);
    }
    dockerfile = path.join(work, "Dockerfile.levant");
    const repoIgnore = await fsp.readFile(path.join(contextDir, ".dockerignore"), "utf8").catch(() => "");
    await fsp.writeFile(dockerfile, gen.dockerfile);
    // BuildKit reads <Dockerfile>.dockerignore next to the Dockerfile first (keeps the repo untouched)
    await fsp.writeFile(dockerfile + ".dockerignore", gen.dockerignore + (repoIgnore ? `\n# from the repository's .dockerignore\n${repoIgnore}\n` : ""));
    log.step(`Building image (generated ${d.frameworkName} Dockerfile)…`);
    if (process.env.LEVANT_BUILD_PRINT_DOCKERFILE === "1") for (const l of gen.dockerfile.split("\n")) log.info(l);
  }
  log.info(`Image: ${tag}${cacheFrom.length ? ` (cache from ${cacheFrom[0]})` : ""}`);

  const r = await dockerBuild({
    ...common,
    contextDir,
    dockerfile,
    tag,
    buildArgs,
    secrets,
    target: d.strategy === "dockerfile" ? settings.dockerTarget : null,
    onLine: (l) => log.line(l),
    timeoutMs: left(),
  });
  check();
  if (r.code !== 0) throw new StepError("BUILD", summarizeError(r.tail, `docker build exited with code ${r.code}`), r.tail);
  const info = await imageInfo(tag);
  log.success(`Image built: ${tag}${info ? ` — ${fmtBytes(info.size)}` : ""}`);
  return {
    imageTag: tag,
    meta: {
      framework: d.framework,
      frameworkName: d.frameworkName,
      kind: d.kind,
      strategy: d.strategy,
      port: d.strategy === "dockerfile" ? (info?.exposedPorts[0] ?? d.port) : d.port,
      exposedPorts: info?.exposedPorts,
      imageTag: tag,
      imageSize: info?.size,
    },
  };
}

type Common = {
  proxy: BuildProxy | null;
  tmpDir: string;
  signal: AbortSignal;
  labels: Record<string, string>;
  cacheFrom: string[];
  noCache: boolean;
  buildArgs: Record<string, string>;
  secrets: Record<string, string>;
  left: () => number;
  check: () => void;
};

async function buildCompose(dep: DepWithProject, project: Project, d: Detection, src: FetchedSource, log: BuildLog, c: Common): Promise<{ imageTag: string; meta: BuildMeta }> {
  const file = path.resolve(src.contextDir, d.composeFile ?? "compose.yaml");
  if (!file.startsWith(path.resolve(src.repoDir) + path.sep) || !fs.existsSync(file)) throw new StepError("DETECT", `Compose file not found at ${d.composeFile}`);
  log.step(`Reading ${path.relative(src.repoDir, file)}…`);
  let cfg;
  try {
    cfg = await composeConfig(file, src.contextDir, { ...c.buildArgs, ...c.secrets });
  } catch (e) {
    throw new StepError("DETECT", (e as Error).message);
  }
  const names = Object.keys(cfg.services);
  log.info(`Services: ${names.map((n) => `${n}${cfg.services[n]!.build ? " (build)" : ` (${cfg.services[n]!.image ?? "?"})`}`).join(", ")}`);
  const images: Record<string, string> = {};
  const services: ComposeServiceMeta[] = [];
  let totalSize = 0;
  for (const name of names) {
    const s = cfg.services[name]!;
    if (!s.build) {
      if (!s.image) throw new StepError("DETECT", `Service "${name}" has neither build nor image`);
      images[name] = s.image;
      services.push({ name, image: s.image, built: false, ports: servicePorts(s), definition: {} });
      continue;
    }
    c.check();
    const { context, dockerfile } = await resolveBuildContext(s.build, src.repoDir, c.tmpDir, name).catch((e) => {
      throw new StepError("DETECT", (e as Error).message);
    });
    const tag = imageTagFor(project.id, dep.shortId, name);
    const args: Record<string, string> = { ...c.buildArgs };
    for (const [k, v] of Object.entries(s.build.args ?? {})) if (v != null) args[k] = String(v);
    log.step(`Building service "${name}" (${path.relative(src.repoDir, dockerfile) || "Dockerfile"})…`);
    const r = await dockerBuild({
      contextDir: context,
      dockerfile,
      tag,
      labels: { ...c.labels, "levant.service": name },
      buildArgs: args,
      secrets: c.secrets,
      cacheFrom: c.cacheFrom.map((x) => `${x}-${name}`),
      noCache: c.noCache,
      target: s.build.target ?? null,
      proxy: c.proxy,
      tmpDir: c.tmpDir,
      onLine: (l) => log.line(l),
      signal: c.signal,
      timeoutMs: c.left(),
    });
    c.check();
    if (r.code !== 0) throw new StepError("BUILD", `Service "${name}": ${summarizeError(r.tail, `docker build exited with code ${r.code}`)}`, r.tail);
    const info = await imageInfo(tag);
    totalSize += info?.size ?? 0;
    log.success(`Service "${name}" built: ${tag}${info ? ` — ${fmtBytes(info.size)}` : ""}`);
    images[name] = tag;
    services.push({ name, image: tag, built: true, ports: servicePorts(s), definition: {} });
  }
  const primary = primaryService(cfg);
  const spec = runtimeSpec(cfg, images);
  const primaryPort = servicePorts(cfg.services[primary]!)[0] ?? project.port;
  log.info(`Primary service: ${primary} (port ${primaryPort})`);
  return {
    imageTag: images[primary]!,
    meta: {
      framework: "compose",
      frameworkName: "Docker Compose",
      kind: "COMPOSE",
      strategy: "compose",
      port: primaryPort,
      imageTag: images[primary],
      imageSize: totalSize || undefined,
      composeFile: path.relative(src.contextDir, file),
      compose: services,
      composePrimary: primary,
      // full normalized spec (env values included) — encrypted; runtime: decryptJson(meta.build.composeSpecEnc)
      composeSpecEnc: encryptJson(spec),
    },
  };
}

/**
 * Detected kind/framework are authoritative while the project's framework preset is on auto:
 * Project.kind follows the build (COMPOSE ⇄ WEB/STATIC, WORKER from a Procfile) and Project.framework is filled in.
 * A user-chosen WORKER kind is kept for single-image builds (only COMPOSE overrides it).
 */
export async function syncProjectFromBuild(project: Project, meta: BuildMeta) {
  const settings = parseBuildSettings(project.buildSettings);
  const auto = !settings.framework;
  const data: Prisma.ProjectUpdateInput = {};
  if (auto && project.framework !== meta.framework) data.framework = meta.framework;
  if (auto && meta.strategy !== "image" && project.kind !== meta.kind) {
    const keepWorker = project.kind === "WORKER" && meta.kind !== "COMPOSE";
    if (!keepWorker) data.kind = meta.kind;
  }
  if (Object.keys(data).length) await db.project.update({ where: { id: project.id }, data }).catch(() => {});
  return data;
}

/** Previous images of the project still present locally (cache-from). */
async function previousImages(projectId: string, exceptId: string): Promise<string[]> {
  const prev = await db.deployment.findMany({
    where: { projectId, id: { not: exceptId }, imageTag: { startsWith: imageRepo(projectId) + ":" }, status: { in: ["READY", "SUPERSEDED", "DEPLOYING"] } },
    orderBy: { createdAt: "desc" },
    select: { imageTag: true },
    take: 3,
  });
  for (const p of prev) if (p.imageTag && (await imageExists(p.imageTag))) return [p.imageTag];
  return [];
}

export function describe(d: Detection): string {
  const ver = d.version ? (d.language === "node" ? d.version.split(".")[0] : d.version) : null;
  const parts = [d.frameworkName + (ver ? ` ${ver}` : "")];
  const extra = [d.packageManager, d.nodeVersion && ["node", "bun"].includes(d.language) ? `Node ${d.nodeVersion}` : null, d.pythonVersion ? `Python ${d.pythonVersion}` : null].filter(Boolean);
  if (d.strategy === "dockerfile") return d.meta.inline ? "Inline Dockerfile (project settings)" : `Dockerfile (${d.dockerfilePath})`;
  if (d.strategy === "compose") return `Docker Compose (${d.composeFile})`;
  return `${parts[0]}${extra.length ? ` (${extra.join(", ")})` : ""} → ${d.kind.toLowerCase()} app`;
}

const fmtBytes = (n: number) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const fmtDuration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const redactUrl = (u: string) => u.replace(/\/\/[^@/]+@/, "//***@");
