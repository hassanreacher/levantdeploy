import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "@/lib/env";
import { docker } from "@/lib/docker";
import { runCompose } from "@/lib/runtime/compose";
import { composeProject, containerName, containerSuffix, projectDir, type BaseService } from "./config";

/** `docker compose -p lb_{ref} …` in the project dir (profiles: "studio" / "pooler" when needed). */
export function composeArgs(ref: string, args: string[], profiles: string[] = []): string[] {
  const dir = projectDir(ref);
  return [
    "-p", composeProject(ref),
    "--project-directory", dir,
    "-f", path.join(dir, "docker-compose.yml"),
    ...(fs.existsSync(path.join(dir, "docker-compose.public.yml")) ? ["-f", path.join(dir, "docker-compose.public.yml")] : []),
    "--env-file", path.join(dir, ".env"),
    ...profiles.flatMap((p) => ["--profile", p]),
    ...args,
  ];
}

export async function compose(ref: string, args: string[], opts: { profiles?: string[]; onLine?: (l: string) => void; timeoutMs?: number } = {}) {
  const res = await runCompose(composeArgs(ref, args, opts.profiles), { cwd: projectDir(ref), onLine: opts.onLine, timeoutMs: opts.timeoutMs });
  if (res.code !== 0) throw new Error(`docker compose ${args[0]} failed (exit ${res.code}): ${res.out.trim().split("\n").slice(-15).join("\n")}`);
  return res.out;
}

export type ServiceState = { service: string; container: string; state: string; health: string; running: boolean; healthy: boolean; exitCode?: number };

/** Live state of every container of the project (labels levant.base={ref}). */
export async function stackState(ref: string): Promise<ServiceState[]> {
  const list = await docker().listContainers({ all: true, filters: { label: [`com.docker.compose.project=${composeProject(ref)}`] } });
  return list.map((c) => {
    const service = c.Labels["com.docker.compose.service"] ?? "";
    const status = c.Status ?? "";
    const health = /\(healthy\)/.test(status) ? "healthy" : /\(unhealthy\)/.test(status) ? "unhealthy" : /\(health: starting\)/.test(status) ? "starting" : "none";
    const running = c.State === "running";
    return { service, container: (c.Names[0] ?? "").replace(/^\//, ""), state: c.State, health, running, healthy: running && (health === "healthy" || health === "none") };
  });
}

/**
 * Wait until every listed service runs and (if it has a healthcheck) reports healthy. Throws with the failing
 * service + its last log lines on timeout or when a container exits / restarts in a loop.
 */
export async function waitHealthy(ref: string, services: readonly BaseService[], opts: { timeoutMs?: number; onProgress?: (msg: string) => void } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60_000);
  const done = new Set<string>();
  for (;;) {
    const states = await stackState(ref);
    for (const svc of services) {
      if (done.has(svc)) continue;
      const s = states.find((x) => x.service === svc);
      if (s?.healthy) {
        done.add(svc);
        opts.onProgress?.(`${svc} is ${s.health === "none" ? "running" : "healthy"}`);
      } else if (s && (s.state === "exited" || s.state === "dead")) {
        throw new Error(`${svc} exited:\n${await serviceLogs(ref, svc, 40)}`);
      }
    }
    if (done.size === services.length) return;
    if (Date.now() > deadline) {
      const missing = services.filter((s) => !done.has(s));
      const logs = await Promise.all(missing.slice(0, 3).map(async (m) => `── ${m} ──\n${await serviceLogs(ref, m, 30)}`));
      throw new Error(`timed out waiting for ${missing.join(", ")} to become healthy\n${logs.join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Last N log lines of one service (stdout+stderr). */
export async function serviceLogs(ref: string, service: BaseService | string, tail = 200): Promise<string> {
  try {
    const c = docker().getContainer(containerName(ref, containerSuffix(service as BaseService)));
    const buf = (await c.logs({ stdout: true, stderr: true, tail, timestamps: false })) as unknown as Buffer;
    return demux(buf);
  } catch (e) {
    return `(no logs: ${(e as Error).message})`;
  }
}

export function demux(buf: Buffer): string {
  // docker multiplexed stream: [type(1) 0 0 0 size(4)] payload
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const parts: Buffer[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      parts.push(buf.subarray(i + 8, i + 8 + size));
      i += 8 + size;
    }
    return Buffer.concat(parts).toString("utf8");
  }
  return buf.toString("utf8");
}

/**
 * `docker exec` into a project container (CLI, so stdin/stdout can be streamed to/from files).
 *   execIn(ref, "db", ["psql", …], { stdinFile, stdoutFile })
 */
export function execIn(
  ref: string,
  service: BaseService,
  cmd: string[],
  opts: { stdinFile?: string; stdoutFile?: string; stdin?: string; user?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const args = ["exec", "-i"];
    if (opts.user) args.push("-u", opts.user);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(containerName(ref, containerSuffix(service)), ...cmd);
    const p = spawn("docker", args, { env: { ...process.env, DOCKER_HOST: `unix://${env.DOCKER_SOCKET}` } });
    let out = "";
    let err = "";
    if (opts.stdoutFile) {
      const ws = fs.createWriteStream(opts.stdoutFile, { mode: 0o600 });
      p.stdout.pipe(ws);
    } else p.stdout.on("data", (b: Buffer) => (out = (out + b.toString()).slice(-4_000_000)));
    p.stderr.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-200_000)));
    if (opts.stdinFile) fs.createReadStream(opts.stdinFile).pipe(p.stdin);
    else {
      if (opts.stdin) p.stdin.write(opts.stdin);
      p.stdin.end();
    }
    const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 30 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      // give the file stream a tick to flush
      setTimeout(() => resolve({ code: code ?? 1, out, err }), 50);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out, err: String(e) });
    });
  });
}

/** psql as supabase_admin (superuser) inside the db container → tuples only, unaligned. */
export async function psql(ref: string, sql: string, opts: { db?: string; user?: string } = {}): Promise<string> {
  const r = await execIn(ref, "db", ["psql", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-At", "-U", opts.user ?? "supabase_admin", "-h", "localhost", "-d", opts.db ?? "postgres", "-f", "-"], {
    stdin: sql,
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new Error(`psql failed: ${(r.err || r.out).trim().slice(-2000)}`);
  return r.out;
}

/** IP of the gateway container on a network (dev workers on the host can't resolve container names). */
export async function containerIp(name: string, network?: string): Promise<string | null> {
  try {
    const info = await docker().getContainer(name).inspect();
    const nets = info.NetworkSettings.Networks ?? {};
    const n = network ? nets[network] : Object.values(nets)[0];
    return n?.IPAddress || null;
  } catch {
    return null;
  }
}
