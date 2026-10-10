import { Resolver } from "node:dns/promises";
import { env } from "@/lib/env";

/**
 * DNS lookups used by domain verification. Injectable for tests:
 *   setDnsLookup(fake) / setDnsLookup(null)          // custom implementation
 *   createResolverLookup(["127.0.0.1:5353"])           // real resolver against specific servers (fake DNS server in tests)
 * Default: node Resolver against DNS_RESOLVERS (comma separated, `ip` or `ip:port`).
 */
export type DnsLookup = {
  a(host: string): Promise<string[]>;
  aaaa(host: string): Promise<string[]>;
  cname(host: string): Promise<string[]>;
  txt(host: string): Promise<string[]>;
};

const NO_DATA = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "ESERVFAIL", "ENOTIMP", "EREFUSED", "ECONNREFUSED", "ETIMEOUT", "EBADRESP"]);

async function safe<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (e) {
    if (NO_DATA.has((e as { code?: string }).code ?? "")) return [];
    throw e;
  }
}

export function createResolverLookup(servers: string[], timeoutMs = 3000): DnsLookup {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  if (servers.length) r.setServers(servers);
  const norm = (xs: string[]) => xs.map((x) => x.toLowerCase().replace(/\.$/, ""));
  return {
    a: (h) => safe(r.resolve4(h)),
    aaaa: (h) => safe(r.resolve6(h)),
    cname: async (h) => norm(await safe(r.resolveCname(h))),
    txt: async (h) => (await safe(r.resolveTxt(h))).map((chunks) => chunks.join("")),
  };
}

const g = globalThis as unknown as { __ldDns?: DnsLookup | null };

export function setDnsLookup(l: DnsLookup | null) {
  g.__ldDns = l;
}

export function dnsLookup(): DnsLookup {
  if (g.__ldDns) return g.__ldDns;
  const servers = env.DNS_RESOLVERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  g.__ldDns = createResolverLookup(servers);
  return g.__ldDns;
}
