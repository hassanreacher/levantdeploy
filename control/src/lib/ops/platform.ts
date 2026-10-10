import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { db } from "@/lib/db";
import { maskSecret } from "@/lib/crypto";
import { currentVersion } from "./version";

/**
 * Everything Settings → General / Limits / Email / Backups shows, in one serialisable object (ops area).
 * Domain + dashboard host are install-time values (env, written by install.sh) — every area derives URLs from env.
 */
export async function platformOverview() {
  const [registration, serverIps, buildConcurrency, buildTimeout, uploadMax, limits, smtp, backups, updateUrl, users, teams, projects] = await Promise.all([
    getSetting("platform.registration"),
    getSetting("platform.serverIps"),
    getSetting("build.concurrency"),
    getSetting("build.timeoutMinutes"),
    getSetting("uploads.maxSizeMb"),
    getSetting("limits.defaults"),
    getSetting("smtp"),
    getSetting("backups.control"),
    getSetting("updates.checkUrl"),
    db.user.count(),
    db.team.count(),
    db.project.count(),
  ]);
  const envIps = (env.SERVER_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ipv4 = serverIps.ipv4 || envIps.find((x) => x.includes(".")) || null;
  const ipv6 = serverIps.ipv6 || envIps.find((x) => x.includes(":")) || null;
  return {
    version: currentVersion(),
    platformDomain: env.PLATFORM_DOMAIN,
    dashboardHost: env.DASHBOARD_HOST,
    scheme: env.PLATFORM_SCHEME,
    tls: env.PROXY_TLS,
    installDir: process.env.LEVANT_INSTALL_DIR || "/opt/levantdeploy",
    registration,
    registrationLockedByEnv: process.env.REGISTRATION === "open",
    serverIps: { ipv4, ipv6, detectedAt: serverIps.detectedAt, fromEnv: envIps },
    limits: {
      buildConcurrency: buildConcurrency,
      buildTimeoutMinutes: buildTimeout,
      uploadMaxSizeMb: uploadMax,
      defaults: limits,
    },
    smtp: smtp
      ? { source: "settings" as const, host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, passwordSet: !!smtp.passEnc, passwordHint: smtp.passEnc ? maskSecret("x".repeat(8)) : "", from: smtp.from }
      : env.SMTP_HOST
        ? { source: "env" as const, host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER ?? null, passwordSet: !!env.SMTP_PASS, passwordHint: "", from: env.SMTP_FROM }
        : null,
    backups,
    updateUrl: updateUrl,
    updateUrlFromEnv: process.env.LEVANT_UPDATE_URL || null,
    counts: { users, teams, projects },
  };
}

export type PlatformOverview = Awaited<ReturnType<typeof platformOverview>>;

/** DNS records the owner must create, derived from domain + dashboard host + IPs. */
export function dnsRecords(o: Pick<PlatformOverview, "platformDomain" | "dashboardHost" | "serverIps">) {
  const dash = o.dashboardHost.replace(/:\d+$/, "");
  const rows: { type: "A" | "AAAA"; name: string; value: string; purpose: string }[] = [];
  const add = (name: string, purpose: string) => {
    rows.push({ type: "A", name, value: o.serverIps.ipv4 || "<server IPv4>", purpose });
    if (o.serverIps.ipv6) rows.push({ type: "AAAA", name, value: o.serverIps.ipv6, purpose });
  };
  add(dash, "Dashboard + API");
  add(`*.${o.platformDomain}`, "Deployment URLs and previews");
  return rows;
}
