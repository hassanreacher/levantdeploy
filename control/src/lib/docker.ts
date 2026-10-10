import Docker from "dockerode";

/**
 * Shared dockerode client (worker + API routes). Socket from DOCKER_SOCKET (default /var/run/docker.sock).
 * Labels every LevantDeploy-managed object with `levant.managed=true` (+ levant.project / levant.deployment).
 */
const g = globalThis as unknown as { __docker?: Docker };

export function docker(): Docker {
  g.__docker ??= new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" });
  return g.__docker;
}

export const LABELS = {
  managed: "levant.managed",
  project: "levant.project",
  deployment: "levant.deployment",
  team: "levant.team",
  kind: "levant.kind",
} as const;

export const dockerNetwork = () => process.env.DOCKER_NETWORK || "levant_net";

/** Creates the shared bridge network if missing (idempotent). */
export async function ensureNetwork(name = dockerNetwork()) {
  const d = docker();
  const nets = await d.listNetworks({ filters: { name: [name] } });
  if (nets.some((n) => n.Name === name)) return;
  await d.createNetwork({ Name: name, Driver: "bridge", Labels: { [LABELS.managed]: "true" } });
}
