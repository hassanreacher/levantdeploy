import net from "node:net";

/**
 * Detect this server's public IPv4 / IPv6 by asking a few "what is my IP" services (first answer wins).
 * Used by Settings → General ("Detect") and printed by install.sh. Worker-safe.
 */
const V4 = ["https://api.ipify.org", "https://ipv4.icanhazip.com", "https://ifconfig.me/ip", "https://checkip.amazonaws.com"];
const V6 = ["https://api6.ipify.org", "https://ipv6.icanhazip.com"];

async function ask(urls: string[], family: 4 | 6): Promise<string | null> {
  const tries = urls.map(async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(4000), headers: { accept: "text/plain" } });
    if (!r.ok) throw new Error(String(r.status));
    const ip = (await r.text()).trim();
    if (net.isIP(ip) !== family) throw new Error("not an IP");
    return ip;
  });
  try {
    return await Promise.any(tries);
  } catch {
    return null;
  }
}

export async function detectPublicIps(): Promise<{ ipv4: string | null; ipv6: string | null }> {
  const [ipv4, ipv6] = await Promise.all([ask(V4, 4), ask(V6, 6)]);
  return { ipv4, ipv6 };
}

export function isIpv4(s: string) {
  return net.isIPv4(s);
}
export function isIpv6(s: string) {
  return net.isIPv6(s);
}
