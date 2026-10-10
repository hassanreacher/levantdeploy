/**
 * LevantBase compat suite — shared helpers.
 *
 * Everything goes over the network exactly like a real app would: the official `@supabase/supabase-js` client talks
 * HTTPS to `https://{ref}.{BASE_DOMAIN}` through LevantDeploy's Caddy (local CA via NODE_EXTRA_CA_CERTS), and the
 * platform side (project creation, SQL, functions, secrets, settings) goes through the public LevantDeploy REST API
 * (`/api/v1/base/...`) with an API token. Nothing imports the control plane's code.
 *
 * LB_EDGE=<ip> makes every `*.{BASE_DOMAIN}` hostname connect to that address (like `curl --resolve`) so no
 * /etc/hosts edit is needed; TLS SNI and certificate verification still use the real hostname.
 */
import dns from "node:dns";
import { Agent } from "undici";
import WebSocket from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const cfg = {
  api: (process.env.LB_API ?? "http://localhost:3111").replace(/\/$/, ""),
  token: process.env.LB_TOKEN ?? "",
  team: process.env.LB_TEAM ?? "admin",
  ref: process.env.LB_REF ?? "",
  edge: process.env.LB_EDGE ?? "",
  /** SMTP sink: hostname the project's auth container uses + HTTP URL the suite reads mails from */
  smtpHost: process.env.LB_SMTP_HOST ?? "",
  smtpPort: Number(process.env.LB_SMTP_PORT ?? 2525),
  smtpApi: (process.env.LB_SMTP_API ?? "").replace(/\/$/, ""),
  keep: process.env.LB_KEEP === "1",
};

// ── name resolution: *.base.<domain> → LB_EDGE (Caddy) ──────────────────────────────────────────────────────────────
type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
export function lookup(hostname: string, opts: dns.LookupOptions | number | LookupCb, cb?: LookupCb) {
  const callback = (typeof opts === "function" ? opts : cb) as LookupCb;
  const o = (typeof opts === "object" ? opts : {}) as dns.LookupOptions;
  if (cfg.edge && !/^(localhost|127\.|\d+\.\d+\.\d+\.\d+$)/.test(hostname)) {
    return o.all ? callback(null, [{ address: cfg.edge, family: 4 }]) : callback(null, cfg.edge, 4);
  }
  return dns.lookup(hostname, o, callback as never);
}

export const dispatcher = new Agent({ connect: { lookup: lookup as never }, keepAliveTimeout: 2000 });

/** global fetch routed through our resolver (Node's fetch accepts an undici dispatcher) */
export const lbFetch: typeof fetch = (input, init) => fetch(input, { ...(init ?? {}), dispatcher } as RequestInit);

/** WebSocket transport for realtime-js with the same resolver */
export class LbWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { lookup: lookup as never });
  }
}

export function client(url: string, key: string, opts: { accessToken?: string } = {}): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: lbFetch, ...(opts.accessToken ? { headers: { Authorization: `Bearer ${opts.accessToken}` } } : {}) },
    realtime: { transport: LbWebSocket as never, timeout: 20_000 },
  });
}

// ── platform API (LevantDeploy) ──────────────────────────────────────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(cfg.api + path, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = text;
  }
  if (!res.ok) throw new ApiError(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`, res.status, j);
  return j as T;
}

export async function sql(ref: string, statement: string): Promise<{ rows: Record<string, string | null>[]; rowCount: number }> {
  return api("POST", `/api/v1/base/projects/${ref}/sql`, { sql: statement });
}

// ── results ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Result = { area: string; name: string; status: "pass" | "fail" | "skip"; ms: number; detail: string };
export const results: Result[] = [];

export async function check(area: string, name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "";
    results.push({ area, name, status: "pass", ms: Date.now() - t0, detail });
    console.log(`ok    ${area.padEnd(10)} ${name}${detail ? `  — ${detail}` : ""}`);
    return true;
  } catch (e) {
    const detail = (e as Error).message?.split("\n")[0]?.slice(0, 300) ?? String(e);
    results.push({ area, name, status: "fail", ms: Date.now() - t0, detail });
    console.log(`FAIL  ${area.padEnd(10)} ${name}  — ${detail}`);
    return false;
  }
}

export function skip(area: string, name: string, why: string) {
  results.push({ area, name, status: "skip", ms: 0, detail: why });
  console.log(`skip  ${area.padEnd(10)} ${name}  — ${why}`);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
export function eq<T>(actual: T, expected: T, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
/** the success member(s) of a supabase-js `{ data, error }` result union */
type Success<R> = R extends { error: infer E } ? (null extends E ? R : never) : R;
type OkData<R> = Success<R> extends { data: infer D } ? D : undefined;

/** unwrap a supabase-js `{ data, error }` result (throws with the server's message on error) */
export function ok<R extends { error: unknown }>(r: R, what = "request"): OkData<R> {
  if (r.error) {
    const e = r.error as { message?: string; code?: string; status?: number };
    throw new Error(`${what}: ${e.message ?? JSON.stringify(e)}${e.code ? ` (${e.code})` : ""}${e.status ? ` [${e.status}]` : ""}`);
  }
  return (r as unknown as { data: OkData<R> }).data;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 30_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
    await sleep(everyMs);
  }
}

export const uniq = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** a small valid PNG (solid colour) for upload / image-transformation checks */
export async function png(width: number, height: number, rgb: [number, number, number] = [30, 120, 220]): Promise<Buffer> {
  const zlib = await import("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** width × height of a PNG / JPEG / WebP buffer (enough for the transformation check) */
export function imageSize(b: Buffer): { type: string; width: number; height: number } | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") {
    const kind = b.subarray(12, 16).toString("ascii");
    if (kind === "VP8 ") return { type: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { type: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { type: "jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
