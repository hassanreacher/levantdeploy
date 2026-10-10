import crypto from "node:crypto";
import { getSetting, setSetting, type SettingValue } from "@/lib/settings";

/**
 * Platform-level build settings (owner only): build proxy + extra CA, Docker Hub mirror.
 * Used by GET/PUT /api/v1/platform/build and Platform Settings → Build.
 */
export type CaInfo = { subject: string; issuer: string; validTo: string; fingerprint: string; expired: boolean };
export type PlatformBuildView = {
  proxy: {
    enabled: boolean;
    httpProxy: string | null;
    httpsProxy: string | null;
    noProxy: string | null;
    network: "host" | "default";
    caCertPem: string | null;
    certificates: CaInfo[];
  };
  registryMirror: string | null;
  concurrency: number;
  timeoutMinutes: number;
  /** proxy variables found in the worker/server environment (hint for "use server settings") */
  serverEnv: { httpsProxy: string | null; noProxy: string | null };
};

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function parseCaBundle(pem: string): CaInfo[] {
  const out: CaInfo[] = [];
  for (const block of pem.match(PEM_RE) ?? []) {
    const c = new crypto.X509Certificate(block); // throws on invalid data
    const validTo = new Date(c.validTo);
    out.push({
      subject: c.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) ?? c.subject.split("\n")[0] ?? "",
      issuer: c.issuer.split("\n").find((l) => l.startsWith("CN="))?.slice(3) ?? "",
      validTo: validTo.toISOString(),
      fingerprint: c.fingerprint256.slice(0, 23),
      expired: validTo.getTime() < Date.now(),
    });
  }
  return out;
}

/** "http://user:pass@host:3128" → "http://user:••••@host:3128" */
export function maskProxyUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  return u.replace(/^(\w+:\/\/[^:/@]+):[^@/]+@/, "$1:••••@");
}

export async function platformBuildView(): Promise<PlatformBuildView> {
  const [p, mirror, concurrency, timeoutMinutes] = await Promise.all([
    getSetting("build.proxy"),
    getSetting("build.registryMirror"),
    getSetting("build.concurrency"),
    getSetting("build.timeoutMinutes"),
  ]);
  let certificates: CaInfo[] = [];
  try {
    certificates = p.caCertPem ? parseCaBundle(p.caCertPem) : [];
  } catch {
    certificates = [];
  }
  return {
    proxy: {
      enabled: !!(p.httpProxy || p.httpsProxy || p.caCertPem || p.network === "host"),
      httpProxy: maskProxyUrl(p.httpProxy),
      httpsProxy: maskProxyUrl(p.httpsProxy),
      noProxy: p.noProxy ?? null,
      network: p.network ?? "default",
      caCertPem: p.caCertPem ?? null,
      certificates,
    },
    registryMirror: mirror,
    concurrency,
    timeoutMinutes,
    serverEnv: {
      httpsProxy: maskProxyUrl(process.env.HTTPS_PROXY || process.env.https_proxy || null),
      noProxy: process.env.NO_PROXY || process.env.no_proxy || null,
    },
  };
}

/** Keep the stored secret part when the client sends back the masked URL. */
function unmask(next: string | null | undefined, stored: string | undefined): string | undefined {
  if (!next) return undefined;
  if (next.includes("••••") && stored && maskProxyUrl(stored) === next) return stored;
  return next;
}

export async function savePlatformBuild(input: {
  proxy?: { httpProxy?: string | null; httpsProxy?: string | null; noProxy?: string | null; caCertPem?: string | null; network?: "host" | "default" } | null;
  registryMirror?: string | null;
}) {
  const changed: string[] = [];
  if (input.proxy !== undefined) {
    const cur = await getSetting("build.proxy");
    const next: SettingValue<"build.proxy"> = {};
    if (input.proxy) {
      const httpProxy = unmask(input.proxy.httpProxy, cur.httpProxy);
      const httpsProxy = unmask(input.proxy.httpsProxy, cur.httpsProxy);
      if (httpProxy) next.httpProxy = httpProxy;
      if (httpsProxy) next.httpsProxy = httpsProxy;
      if (input.proxy.noProxy) next.noProxy = input.proxy.noProxy;
      if (input.proxy.caCertPem) next.caCertPem = input.proxy.caCertPem.trim() + "\n";
      if (input.proxy.network === "host") next.network = "host";
    }
    await setSetting("build.proxy", next);
    changed.push("build.proxy");
  }
  if (input.registryMirror !== undefined) {
    await setSetting("build.registryMirror", input.registryMirror || null);
    changed.push("build.registryMirror");
  }
  return changed;
}
