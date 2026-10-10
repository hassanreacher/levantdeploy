import fsp from "node:fs/promises";
import path from "node:path";
import { execCapture, execStream, type ExecResult } from "./exec";
import { getSetting, type SettingValue } from "@/lib/settings";
import { CA_SECRET_ID } from "./dockerfile";

/**
 * `docker build` (BuildKit) runner: streams every line, labels, cache-from, build args, BuildKit secrets,
 * optional build proxy (proxy build args + CA secret + --network host), cancellation and timeout.
 */

export type BuildProxy = SettingValue<"build.proxy">;

export type DockerBuildInput = {
  contextDir: string;
  dockerfile: string;
  tag: string;
  labels?: Record<string, string>;
  /** non-secret build args (--build-arg K=V) */
  buildArgs?: Record<string, string>;
  /** secret values → BuildKit secrets (id = key), passed through the CLI env, never in argv */
  secrets?: Record<string, string>;
  cacheFrom?: string[];
  /** --no-cache (redeploy without cache) */
  noCache?: boolean;
  target?: string | null;
  proxy?: BuildProxy | null;
  /** where to write temp files (CA bundle) */
  tmpDir: string;
  onLine: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** redact these values from the output */
  redact?: string[];
};

export type DockerBuildResult = ExecResult & { imageId: string | null };

/** Effective build proxy: the platform setting (empty object = disabled). */
export async function getBuildProxy(): Promise<BuildProxy | null> {
  const p = await getSetting("build.proxy");
  if (!p || (!p.httpProxy && !p.httpsProxy && !p.caCertPem && !p.network)) return null;
  return p;
}

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "ftp_proxy"];

/** docker CLI environment without the host's proxy variables (they would otherwise leak into builds) */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (PROXY_ENV.includes(k) || k.startsWith("LEVANT_SECRET_") || k.startsWith("npm_config_") || k === "GIT_CONFIG_COUNT" || k.startsWith("GIT_CONFIG_")) continue;
    env[k] = v;
  }
  env.DOCKER_BUILDKIT = "1";
  env.BUILDKIT_PROGRESS = "plain";
  env.DOCKER_CLI_HINTS = "false";
  return { ...env, ...extra };
}

/** proxy build args (predefined ARGs: usable in every RUN without declaration and excluded from the image history) */
export function proxyBuildArgs(p: BuildProxy | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!p) return out;
  if (p.httpProxy) out.HTTP_PROXY = out.http_proxy = p.httpProxy;
  if (p.httpsProxy) out.HTTPS_PROXY = out.https_proxy = p.httpsProxy;
  if (p.noProxy) out.NO_PROXY = out.no_proxy = p.noProxy;
  return out;
}

export async function imageExists(ref: string): Promise<boolean> {
  const r = await execCapture("docker", ["image", "inspect", "--format", "{{.Id}}", ref], { env: cliEnv() });
  return r.code === 0;
}

export async function imageInfo(ref: string): Promise<{ id: string; size: number; exposedPorts: number[] } | null> {
  const r = await execCapture("docker", ["image", "inspect", "--format", "{{json .}}", ref], { env: cliEnv() });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { Id: string; Size: number; Config?: { ExposedPorts?: Record<string, unknown> } };
    const ports = Object.keys(j.Config?.ExposedPorts ?? {})
      .map((k) => Number(k.split("/")[0]))
      .filter((n) => n > 0);
    return { id: j.Id, size: j.Size, exposedPorts: ports };
  } catch {
    return null;
  }
}

export function buildArgsList(input: DockerBuildInput): { args: string[]; env: Record<string, string> } {
  const args = ["build", "--progress=plain", "-f", input.dockerfile, "-t", input.tag];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.labels ?? {})) args.push("--label", `${k}=${v}`);
  const ba = { ...proxyBuildArgs(input.proxy), ...(input.buildArgs ?? {}), BUILDKIT_INLINE_CACHE: "1" };
  for (const [k, v] of Object.entries(ba)) args.push("--build-arg", `${k}=${v}`);
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    const envName = `LEVANT_SECRET_${k}`;
    env[envName] = v;
    args.push("--secret", `id=${k},env=${envName}`);
  }
  if (input.noCache) args.push("--no-cache");
  else for (const c of input.cacheFrom ?? []) args.push("--cache-from", c);
  if (input.target) args.push("--target", input.target);
  if (input.proxy?.network === "host") args.push("--network", "host");
  return { args, env };
}

export async function dockerBuild(input: DockerBuildInput): Promise<DockerBuildResult> {
  const { args, env } = buildArgsList(input);
  if (input.proxy?.caCertPem) {
    const caFile = path.join(input.tmpDir, "levant-ca.pem");
    await fsp.writeFile(caFile, input.proxy.caCertPem.trim() + "\n", { mode: 0o600 });
    args.push("--secret", `id=${CA_SECRET_ID},src=${caFile}`);
  }
  const iid = path.join(input.tmpDir, `iid-${Date.now()}`);
  args.push("--iidfile", iid, input.contextDir);
  const redact = [...(input.redact ?? []), ...Object.values(input.secrets ?? {}).filter((v) => v.length >= 6)];
  const r = await execStream("docker", args, {
    env: cliEnv(env),
    cwd: input.contextDir,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    onLine: (l) => input.onLine(l),
    redact,
    tail: 300,
  });
  const imageId = r.code === 0 ? ((await fsp.readFile(iid, "utf8").catch(() => "")) || null) : null;
  await fsp.rm(iid, { force: true }).catch(() => {});
  return { ...r, imageId };
}

export async function dockerPull(image: string, onLine: (l: string) => void, signal?: AbortSignal, timeoutMs?: number) {
  return execStream("docker", ["pull", image], { env: cliEnv(), onLine, signal, timeoutMs });
}

export async function removeImage(ref: string) {
  await execCapture("docker", ["image", "rm", "-f", ref], { env: cliEnv() });
}
