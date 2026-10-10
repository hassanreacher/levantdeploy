import { platformDomain } from "@/lib/domains/platform";

/** preview-{id}.{PLATFORM_DOMAIN} → builder project id (20–40 [a-z0-9]); null for any other host. Edge/worker-safe. */
export function builderIdFromHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const pd = platformDomain();
  if (!host.endsWith(`.${pd}`)) return null;
  const m = /^preview-([a-z0-9]{20,40})$/.exec(host.slice(0, -pd.length - 1));
  return m ? m[1]! : null;
}
