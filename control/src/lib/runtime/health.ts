import net from "node:net";
import type { ContainerRef } from "./containers";
import { containerIp, inspectSafe, tailLogs } from "./containers";
import { statusAlive, type HealthConfig } from "./settings";

export class HealthError extends Error {
  constructor(
    message: string,
    public logs: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One HTTP probe → status code (0 = connection failed). */
export async function httpProbe(url: string, timeoutMs = 3000): Promise<number> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "LevantDeploy-Healthcheck/1" } });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

export function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * Wait until a replica is healthy:
 *  - http:    GET http://<ip>:<port><path> → alive per `accept` (default 2xx–4xx; 5xx = not alive)
 *  - tcp:     port accepts connections
 *  - running: container stays running (no restart) for `stableMs` (WORKER kind)
 * Fails fast when the container exits (or crash-loops ≥ 3 restarts). Timeout → HealthError with the last logs.
 */
export async function waitHealthy(
  ref: ContainerRef,
  cfg: HealthConfig,
  opts: { onLog?: (line: string) => void; isCanceled?: () => Promise<boolean>; probeHost?: string } = {},
): Promise<{ ms: number; status?: number }> {
  const t0 = Date.now();
  const deadline = t0 + cfg.timeoutMs;
  let lastStatus = 0;
  let lastNote = 0;
  let startRestarts: number | null = null;
  while (Date.now() < deadline) {
    if (opts.isCanceled && (await opts.isCanceled())) throw new HealthError("Canceled", "");
    const info = await inspectSafe(ref.id);
    if (!info) throw new HealthError(`Container ${ref.name} disappeared`, "");
    const st = info.State;
    startRestarts ??= info.RestartCount ?? 0;
    const restarts = (info.RestartCount ?? 0) - startRestarts;
    if (!st.Running && !st.Restarting && (st.Status === "exited" || st.Status === "dead")) {
      // with a restart policy docker may restart it shortly; give it a moment unless the policy is "no"
      const policy = info.HostConfig?.RestartPolicy?.Name;
      if (!policy || policy === "no" || restarts >= 3 || Date.now() - t0 > 5000) {
        throw new HealthError(`Container exited with code ${st.ExitCode}${st.Error ? ` (${st.Error})` : ""}`, await tailLogs(ref.id, 60));
      }
    }
    if (restarts >= 3) throw new HealthError(`Container is crash-looping (${restarts} restarts)`, await tailLogs(ref.id, 60));
    if (st.Running) {
      const ip = opts.probeHost ?? containerIp(info);
      if (cfg.type === "running") {
        const up = Date.now() - new Date(st.StartedAt).getTime();
        if (restarts === 0 && up >= cfg.stableMs) return { ms: Date.now() - t0 };
      } else if (ip) {
        if (cfg.type === "tcp") {
          if (await tcpProbe(ip, ref.port)) return { ms: Date.now() - t0 };
        } else {
          lastStatus = await httpProbe(`http://${ip}:${ref.port}${cfg.path}`);
          if (statusAlive(lastStatus, cfg.accept)) return { ms: Date.now() - t0, status: lastStatus };
        }
      }
    }
    if (opts.onLog && Date.now() - lastNote > 10_000) {
      lastNote = Date.now();
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs > 0)
        opts.onLog(
          `  …replica ${ref.replica} not healthy yet (${secs}s${cfg.type === "http" ? `, last status ${lastStatus || "no response"}` : ""})`,
        );
    }
    await sleep(cfg.intervalMs);
  }
  const what =
    cfg.type === "http"
      ? `HTTP GET ${cfg.path} on port ${ref.port} (last status: ${lastStatus || "no response"})`
      : cfg.type === "tcp"
        ? `TCP port ${ref.port}`
        : `container running for ${cfg.stableMs / 1000}s`;
  throw new HealthError(`Health check timed out after ${Math.round(cfg.timeoutMs / 1000)}s waiting for ${what}`, await tailLogs(ref.id, 60));
}
