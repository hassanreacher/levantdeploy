import { domainToASCII } from "node:url";
import net from "node:net";

/**
 * Hostname normalisation + validation for custom domains (pure, tested).
 * Accepts "Example.COM", "https://www.example.com/path", "bücher.de" (→ punycode). Rejects IPs, single labels,
 * wildcards, reserved TLDs and anything under the platform domain / the dashboard host.
 */
export function normalizeHostname(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").split("/")[0]!.split("?")[0]!.split("#")[0]!;
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  // wildcard: normalise the base, keep the leading "*." label
  if (h.startsWith("*.")) {
    const base = h.slice(2);
    return `*.${domainToASCII(base) || base}`;
  }
  const ascii = domainToASCII(h);
  return ascii || h;
}

/** `*.example.com` → true (exactly one leading `*.` label). */
export const isWildcard = (host: string) => host.startsWith("*.");
/** `*.example.com` → `example.com`; exact hosts unchanged. */
export const wildcardBase = (host: string) => (isWildcard(host) ? host.slice(2) : host);
/** For a concrete host, the wildcard hostname that would cover it (`a.example.com` → `*.example.com`), or null. */
export function coveringWildcard(host: string): string | null {
  const i = host.indexOf(".");
  if (i <= 0) return null;
  const parent = host.slice(i + 1);
  return parent.includes(".") ? `*.${parent}` : null;
}

/**
 * Common multi-label public suffixes (no PSL dependency): `*.co.uk` would match every company in the UK.
 * A wildcard's base must have at least one label in front of the public suffix.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "co.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "co.kr", "com.br", "com.cn", "com.tr", "com.mx", "com.ar", "com.sa", "com.eg", "com.lb",
  "com.sy", "com.jo", "com.iq", "com.kw", "com.qa", "com.om", "com.bh", "co.il", "co.za", "co.in", "com.sg", "com.my",
  "com.hk", "com.tw", "com.pk", "com.ng", "github.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
]);

const RESERVED_TLDS = new Set(["localhost", "local", "internal", "invalid", "test", "example", "onion", "arpa", "lan", "home"]);

export function validateHostname(host: string, opts: { platformDomain: string; dashboardHost?: string; allowReservedTlds?: boolean }): string | null {
  if (!host) return "Enter a domain";
  if (isWildcard(host)) {
    const base = host.slice(2);
    if (base.includes("*")) return "Only one leading wildcard label is allowed (*.example.com)";
    if (base.split(".").length < 2 || MULTI_LABEL_SUFFIXES.has(base))
      return "A wildcard must be under a domain you own (e.g. *.example.com, not *.com)";
    const pd = opts.platformDomain.toLowerCase();
    if (base === pd || base.endsWith(`.${pd}`))
      return `Wildcards on ${pd} are managed by LevantDeploy`;
    return validateHostname(base, opts);
  }
  if (host.length > 253) return "Domain is too long";
  if (net.isIP(host)) return "IP addresses can't be added as domains";
  if (host.includes("*")) return "Wildcards are only allowed as the first label (*.example.com)";
  const labels = host.split(".");
  if (labels.length < 2) return "Enter a full domain like example.com";
  for (const l of labels) {
    if (!l.length) return "Domain has an empty label";
    if (l.length > 63) return "Each part of the domain must be 63 characters or less";
    if (!/^[a-z0-9-]+$/.test(l) && !/^xn--[a-z0-9-]+$/.test(l)) return "Domain contains invalid characters";
    if (l.startsWith("-") || l.endsWith("-")) return "Domain parts can't start or end with a dash";
  }
  const pd = opts.platformDomain.toLowerCase();
  if (host === pd || host.endsWith(`.${pd}`)) return `Subdomains of ${pd} are managed by LevantDeploy — rename the project's free domain instead`;
  const dash = opts.dashboardHost?.replace(/:\d+$/, "").toLowerCase();
  if (dash && host === dash) return "This is the dashboard's domain";
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return "Invalid top-level domain";
  if (RESERVED_TLDS.has(tld) && !opts.allowReservedTlds) return `.${tld} domains can't be used on the public internet`;
  return null;
}

/** "www.example.com" → "example.com"; "example.com" → "www.example.com" (only for apex/www pairs). */
export function wwwCounterpart(host: string): string | null {
  if (host.startsWith("www.")) return host.split(".").length >= 3 ? host.slice(4) : null;
  return host.split(".").length === 2 ? `www.${host}` : null;
}

/** Apex = exactly two labels (good enough for DNS instructions; co.uk-style suffixes get the CNAME advice too). */
export const isApex = (host: string) => host.split(".").length === 2;

/** A valid label for the free `{label}.{PLATFORM_DOMAIN}` subdomain. */
export function validateSubdomainLabel(label: string): string | null {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return "Use 1–63 lowercase letters, digits or dashes (not at the start/end)";
  if (/-git-/.test(label)) return '"-git-" is reserved for branch URLs';
  if (["www", "api", "app", "admin", "dashboard", "cname", "mail", "smtp", "ns1", "ns2", "status", "caddy", "control"].includes(label))
    return "This name is reserved";
  return null;
}
