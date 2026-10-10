import type Docker from "dockerode";
import type { Deployment, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { docker, dockerNetwork, ensureNetwork, LABELS } from "@/lib/docker";
import { dnsLabel } from "@/lib/deployments";
import { buildRuntimeEnv, envToList } from "./env";
import { runtimeSettings } from "./settings";

/** What runtime stores in Deployment.containerIds. */
export type ContainerRef = {
  id: string;
  name: string;
  /** 1-based replica number */
  replica: number;
  port: number;
  /** DNS alias on levant_net that Caddy dials (`{alias}:{port}`) */
  alias: string;
  /** compose service name (COMPOSE kind) */
  service?: string;
  /** the routed (public) container of a compose stack */
  public?: boolean;
};

export const EXTRA_LABELS = {
  replica: "levant.replica",
  target: "levant.target",
  role: "levant.role", // app | cron | db | compose
  database: "levant.database",
  service: "levant.service",
} as const;

export function containerRefs(d: Pick<Deployment, "containerIds">): ContainerRef[] {
  return Array.isArray(d.containerIds) ? (d.containerIds as unknown as ContainerRef[]) : [];
}

export const containerName = (project: Pick<Project, "slug">, dep: Pick<Deployment, "shortId">, replica: number) =>
  `levant_${dnsLabel(project.slug, 30)}_${dep.shortId}_${replica}`;
export const containerAlias = (dep: Pick<Deployment, "shortId">, replica: number) => `ld-${dep.shortId}-${replica}`;

export const volumeDockerName = (projectId: string, name: string) => `levant_vol_${projectId}_${name}`;

const RESTART: Record<string, Docker.HostRestartPolicy> = {
  "unless-stopped": { Name: "unless-stopped" },
  always: { Name: "always" },
  "on-failure": { Name: "on-failure", MaximumRetryCount: 5 },
  no: { Name: "no" },
  never: { Name: "no" },
};

export async function imageExists(tag: string) {
  try {
    await docker().getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Pull an image (used for database add-ons, IMAGE source projects). Resolves when the pull finished. */
export async function pullImage(tag: string, onProgress?: (line: string) => void): Promise<void> {
  const d = docker();
  const stream = await d.pull(tag);
  await new Promise<void>((resolve, reject) => {
    d.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (ev: { status?: string; id?: string; progress?: string }) => {
        if (onProgress && ev.status && !ev.progress) onProgress(`${ev.id ? ev.id + ": " : ""}${ev.status}`);
      },
    );
  });
}

export async function ensureImage(tag: string, onProgress?: (line: string) => void) {
  if (!(await imageExists(tag))) await pullImage(tag, onProgress);
}

/** Create (if missing) the named docker volumes of a project and return Mounts. */
export async function projectMounts(projectId: string): Promise<Docker.MountSettings[]> {
  const vols = await db.volume.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  const mounts: Docker.MountSettings[] = [];
  for (const v of vols) {
    const name = v.dockerName || volumeDockerName(projectId, v.name);
    await ensureVolume(name, { [LABELS.project]: projectId, "levant.volume": v.name });
    if (!v.dockerName) await db.volume.update({ where: { id: v.id }, data: { dockerName: name } });
    mounts.push({ Type: "volume", Source: name, Target: v.mountPath });
  }
  return mounts;
}

export async function ensureVolume(name: string, labels: Record<string, string> = {}) {
  const d = docker();
  try {
    await d.getVolume(name).inspect();
  } catch {
    await d.createVolume({ Name: name, Labels: { [LABELS.managed]: "true", ...labels } });
  }
}

/** Create + start one replica of a deployment. */
export async function createAppContainer(project: Project, dep: Deployment, replica: number): Promise<ContainerRef> {
  if (!dep.imageTag) throw new Error("Deployment has no image");
  await ensureNetwork();
  const d = docker();
  const rs = runtimeSettings(project);
  const name = containerName(project, dep, replica);
  const alias = containerAlias(dep, replica);
  // a leftover container with the same name (crashed worker / retry) is replaced
  await removeContainer(name).catch(() => {});
  const env = await buildRuntimeEnv(project, dep, { replica });
  const mounts = await projectMounts(project.id);
  const labels: Record<string, string> = {
    [LABELS.managed]: "true",
    [LABELS.team]: project.teamId,
    [LABELS.project]: project.id,
    [LABELS.deployment]: dep.id,
    [LABELS.kind]: project.kind,
    [EXTRA_LABELS.replica]: String(replica),
    [EXTRA_LABELS.target]: dep.target,
    [EXTRA_LABELS.role]: "app",
  };
  const hostConfig: Docker.HostConfig = {
    NetworkMode: dockerNetwork(),
    RestartPolicy: RESTART[project.restartPolicy] ?? RESTART["unless-stopped"],
    Mounts: mounts,
    LogConfig: { Type: "json-file", Config: { "max-size": rs.logMaxSize ?? "10m", "max-file": String(rs.logMaxFile ?? 3) } },
    Init: true,
    SecurityOpt: ["no-new-privileges"],
  };
  if (project.cpuLimit) hostConfig.NanoCpus = Math.round(project.cpuLimit * 1e9);
  if (project.memoryLimitMb) {
    hostConfig.Memory = project.memoryLimitMb * 1024 * 1024;
    hostConfig.MemorySwap = hostConfig.Memory * 2;
  }
  const c = await d.createContainer({
    name,
    Image: dep.imageTag,
    Env: envToList(env),
    Labels: labels,
    ExposedPorts: { [`${project.port}/tcp`]: {} },
    ...(rs.startCommand ? { Cmd: ["sh", "-c", rs.startCommand] } : {}),
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [dockerNetwork()]: { Aliases: [alias] } } },
  });
  await c.start();
  return { id: c.id, name, replica, port: project.port, alias };
}

export async function removeContainer(idOrName: string) {
  const c = docker().getContainer(idOrName);
  await c.remove({ force: true, v: false });
}

export async function stopContainer(idOrName: string, timeoutSec = 10) {
  try {
    await docker().getContainer(idOrName).stop({ t: timeoutSec });
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code !== 304 && code !== 404) throw e; // 304 = already stopped
  }
}

export async function startContainer(idOrName: string) {
  try {
    await docker().getContainer(idOrName).start();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 304) throw e; // already running
  }
}

export async function inspectSafe(idOrName: string): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker().getContainer(idOrName).inspect();
  } catch {
    return null;
  }
}

/** IP of a container on levant_net (fallback: any network). */
export function containerIp(info: Docker.ContainerInspectInfo): string | null {
  const nets = info.NetworkSettings?.Networks ?? {};
  return nets[dockerNetwork()]?.IPAddress || Object.values(nets).find((n) => n.IPAddress)?.IPAddress || null;
}

/** Strip docker's 8-byte multiplex headers from a non-TTY logs buffer. */
export function demuxBuffer(buf: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i]!;
    const len = buf.readUInt32BE(i + 4);
    if ((type !== 1 && type !== 2 && type !== 0) || buf[i + 1] !== 0 || i + 8 + len > buf.length) {
      // not multiplexed (TTY) → raw
      return buf.toString("utf8");
    }
    out.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  if (i < buf.length && out.length === 0) return buf.toString("utf8");
  return Buffer.concat(out).toString("utf8");
}

/** Last N log lines of a container (stdout+stderr). */
export async function tailLogs(idOrName: string, lines = 50): Promise<string> {
  try {
    const buf = (await docker().getContainer(idOrName).logs({ stdout: true, stderr: true, tail: lines, follow: false })) as unknown as Buffer;
    return demuxBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))).trimEnd();
  } catch (e) {
    return `(could not read logs: ${(e as Error).message})`;
  }
}

/** All containers of a deployment by label (live docker state, includes stopped ones). */
export async function listDeploymentContainers(deploymentId: string) {
  return docker().listContainers({ all: true, filters: { label: [`${LABELS.deployment}=${deploymentId}`] } });
}
