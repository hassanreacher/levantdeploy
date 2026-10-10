import { db } from "@/lib/db";
import type { BaseRoute } from "@/lib/proxy/base";
import { apiHost, gatewayDial, parseBaseHost, studioGateDial, studioHost } from "./config";
import { baseLimitsForTeam } from "./limits";
import { decryptSecrets } from "./secrets";
import { readSettings } from "./settings";

/** DB → Caddy routes for every Base project (called by proxy/state.ts on each syncRoutes()). */
export async function loadBaseRoutes(): Promise<BaseRoute[]> {
  const rows = await db.baseProject.findMany({
    where: { status: { not: "DELETING" } },
    select: { ref: true, status: true, teamId: true, settings: true, secretsEnc: true },
  });
  const out: BaseRoute[] = [];
  for (const r of rows) {
    let gate: string;
    try {
      gate = decryptSecrets(r.secretsEnc).studioGateSecret;
    } catch {
      continue;
    }
    const st = readSettings(r.settings);
    const limits = await baseLimitsForTeam(r.teamId, st.limits);
    const cd = st.customDomain;
    out.push({
      ref: r.ref,
      apiHost: apiHost(r.ref),
      customHosts: cd?.status === "ACTIVE" && cd.hostname ? [cd.hostname.toLowerCase()] : [],
      studioHost: studioHost(r.ref),
      status: r.status,
      gatewayDial: gatewayDial(r.ref),
      studioDial: studioGateDial(r.ref),
      studioGateSecret: gate,
      maxBodyBytes: (limits.maxUploadMb + 1) * 1024 * 1024,
      uploadsBlocked: !!(st.enforcement as { uploadsBlocked?: boolean } | undefined)?.uploadsBlocked,
      dbReadOnly: !!(st.enforcement as { dbReadOnly?: boolean } | undefined)?.dbReadOnly,
    });
  }
  return out;
}

/**
 * tls-ask: `null` = not a base host (let the runtime decide); otherwise whether a certificate may be issued
 * (only for existing, non-deleted projects).
 */
export async function baseHostAllowedForTls(host: string): Promise<boolean | null> {
  const h = parseBaseHost(host);
  if (!h) {
    // ACTIVE custom API domain of a Base project?
    const hostname = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    const c = await db.baseProject.findFirst({
      where: { status: { not: "DELETING" }, settings: { path: ["customDomain", "hostname"], equals: hostname } },
      select: { settings: true },
    });
    return c && readSettings(c.settings).customDomain?.status === "ACTIVE" ? true : null;
  }
  const p = await db.baseProject.findUnique({ where: { ref: h.ref }, select: { status: true } });
  return !!p && p.status !== "DELETING";
}

/** Re-sync Caddy after Base routing changes (custom domain verified/removed, status changes outside the worker). */
export async function syncBaseRoutes() {
  const { syncRoutes } = await import("@/lib/proxy/sync");
  return syncRoutes();
}
