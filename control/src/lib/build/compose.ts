import fsp from "node:fs/promises";
import path from "node:path";
import { execCapture } from "./exec";
import { cliEnv } from "./docker-build";

/**
 * docker-compose support: the compose file is normalized with `docker compose config --format json`
 * (interpolation with the project env vars, env_file inlined, relative paths resolved), then every service
 * with a `build:` section is built by the engine; the parsed service list is handed to runtime via
 * Deployment.meta.build (plain summary) + meta.build.composeSpecEnc (encrypted full spec — it contains env values).
 */

export type ComposeBuild = {
  context: string;
  dockerfile?: string;
  dockerfile_inline?: string;
  args?: Record<string, string | null>;
  target?: string;
};

export type ComposeService = {
  image?: string;
  build?: ComposeBuild;
  ports?: Array<{ target: number; published?: string | number; protocol?: string } | string>;
  expose?: Array<string | number>;
  [k: string]: unknown;
};

export type ComposeConfig = { name?: string; services: Record<string, ComposeService>; volumes?: Record<string, unknown>; networks?: Record<string, unknown> };

export async function composeConfig(file: string, projectDir: string, env: Record<string, string>): Promise<ComposeConfig> {
  const r = await execCapture("docker", ["compose", "-f", file, "--project-directory", projectDir, "config", "--format", "json"], {
    cwd: projectDir,
    env: cliEnv(env),
  });
  if (r.code !== 0) throw new Error(`docker compose config failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
  const cfg = JSON.parse(r.stdout) as ComposeConfig;
  if (!cfg.services || !Object.keys(cfg.services).length) throw new Error("Compose file has no services");
  return cfg;
}

export function servicePorts(s: ComposeService): number[] {
  const out = new Set<number>();
  for (const p of s.ports ?? []) {
    if (typeof p === "string") {
      const n = Number(p.split(":").pop()!.split("/")[0]);
      if (n) out.add(n);
    } else if (p?.target) out.add(Number(p.target));
  }
  for (const e of s.expose ?? []) {
    const n = Number(String(e).split("/")[0]);
    if (n) out.add(n);
  }
  return [...out];
}

/** The service that receives the project's HTTP traffic. */
export function primaryService(cfg: ComposeConfig): string {
  const names = Object.keys(cfg.services);
  const byName = names.find((n) => ["web", "app", "frontend", "server", "api", "site"].includes(n));
  if (byName && servicePorts(cfg.services[byName]!).length) return byName;
  return names.find((n) => servicePorts(cfg.services[n]!).length && cfg.services[n]!.build) ?? names.find((n) => servicePorts(cfg.services[n]!).length) ?? byName ?? names[0]!;
}

/** Validate a build context: must be a directory inside the repository (no URLs, no escaping). */
export async function resolveBuildContext(b: ComposeBuild, repoDir: string, tmpDir: string, service: string): Promise<{ context: string; dockerfile: string }> {
  if (/^[a-z]+:\/\//i.test(b.context) || b.context.startsWith("git@")) throw new Error(`Service "${service}": remote build contexts are not supported`);
  const ctx = path.resolve(b.context);
  const root = path.resolve(repoDir);
  if (ctx !== root && !ctx.startsWith(root + path.sep)) throw new Error(`Service "${service}": build context ${b.context} is outside the repository`);
  let dockerfile: string;
  if (b.dockerfile_inline) {
    dockerfile = path.join(tmpDir, `Dockerfile.${service.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
    await fsp.writeFile(dockerfile, b.dockerfile_inline);
  } else {
    dockerfile = path.resolve(ctx, b.dockerfile ?? "Dockerfile");
    if (!dockerfile.startsWith(root + path.sep)) throw new Error(`Service "${service}": Dockerfile is outside the repository`);
  }
  return { context: ctx, dockerfile };
}

/** Strip compose build sections / absolute host paths for the runtime spec. */
export function runtimeSpec(cfg: ComposeConfig, images: Record<string, string>): ComposeConfig {
  const services: Record<string, ComposeService> = {};
  for (const [name, s] of Object.entries(cfg.services)) {
    const { build: _b, ...rest } = s;
    services[name] = { ...rest, image: images[name] ?? s.image };
  }
  return { ...cfg, services };
}
