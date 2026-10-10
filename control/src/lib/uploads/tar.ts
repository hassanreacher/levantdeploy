import { gzipSync } from "fflate";

/**
 * Minimal ustar writer (+ PAX headers for long names) — runs in the browser (dashboard folder upload) and in Node
 * (templates). Produces .tar.gz bytes accepted by the build area's extractor.
 */
export type TarEntry = { path: string; data: Uint8Array; mode?: number; mtime?: number };

const enc = new TextEncoder();

function writeStr(buf: Uint8Array, off: number, len: number, s: string) {
  const b = enc.encode(s);
  buf.set(b.subarray(0, len), off);
}
function writeOctal(buf: Uint8Array, off: number, len: number, n: number) {
  writeStr(buf, off, len, n.toString(8).padStart(len - 1, "0") + "\0");
}

function header(name: string, size: number, mode: number, mtime: number, type: "0" | "x" | "5", prefix = ""): Uint8Array {
  const h = new Uint8Array(512);
  writeStr(h, 0, 100, name);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, Math.floor(mtime));
  h.fill(0x20, 148, 156); // checksum placeholder (spaces)
  h[156] = type.charCodeAt(0);
  writeStr(h, 257, 6, "ustar\0");
  writeStr(h, 263, 2, "00");
  writeStr(h, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  writeStr(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + enc.encode(body).length !== len) len = String(len).length + enc.encode(body).length;
  return `${len}${body}`;
}

/** Normalises a relative path: forward slashes, no leading "/" or "./", rejects "..". */
export function normalizeEntryPath(p: string): string | null {
  const parts = p.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.includes("..")) return null;
  return parts.join("/");
}

export function createTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const now = Date.now() / 1000;
  for (const e of entries) {
    const path = normalizeEntryPath(e.path);
    if (!path) continue;
    const mode = e.mode ?? 0o644;
    const mtime = e.mtime ?? now;
    const nameBytes = enc.encode(path);
    let name = path;
    if (nameBytes.length > 100) {
      const pax = enc.encode(paxRecord("path", path));
      chunks.push(header("PaxHeader", pax.length, 0o644, mtime, "x"), pad(pax));
      name = path.slice(-99).replace(/^\/+/, "");
    }
    chunks.push(header(name, e.data.length, mode, mtime, "0"));
    chunks.push(pad(e.data));
  }
  chunks.push(new Uint8Array(1024));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function pad(data: Uint8Array): Uint8Array {
  const rem = data.length % 512;
  if (rem === 0) return data;
  const out = new Uint8Array(data.length + (512 - rem));
  out.set(data);
  return out;
}

export function createTarGz(entries: TarEntry[]): Uint8Array {
  return gzipSync(createTar(entries), { level: 6 });
}

/** Directories / files never uploaded (same defaults as the CLI). */
export const DEFAULT_IGNORES = [".git", "node_modules", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".levant", ".cache", "__pycache__", ".venv", "venv", ".DS_Store", "Thumbs.db", ".env", ".env.local"];

export function isDefaultIgnored(rel: string): boolean {
  return rel.split("/").some((seg) => DEFAULT_IGNORES.includes(seg));
}
