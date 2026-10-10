import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

/**
 * Safe archive extraction (tar, tar.gz, zip) for uploaded sources — pure Node, no shelling out.
 *
 * Guards: absolute paths and `..` segments are rejected, symlinks / hardlinks must resolve inside the root,
 * device files / fifos are skipped, writes never follow an existing symlink, total size and entry count are capped.
 */

export type ExtractLimits = { maxBytes?: number; maxEntries?: number; maxFileBytes?: number };
export type ExtractResult = { files: number; dirs: number; links: number; bytes: number; skipped: string[]; format: "tar" | "tar.gz" | "zip" };

export class ArchiveError extends Error {}

const DEFAULTS = { maxBytes: 2 * 1024 ** 3, maxEntries: 200_000, maxFileBytes: 1024 ** 3 };

/** Normalize an archive entry name to a safe relative path (or throw). Strips "./" and a leading "/" is rejected. */
export function safeRelPath(name: string): string | null {
  const n = name.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!n || n === ".") return null;
  if (n.startsWith("/") || /^[a-zA-Z]:\//.test(n)) throw new ArchiveError(`Absolute path in archive: ${name}`);
  const parts = n.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new ArchiveError(`Path traversal in archive: ${name}`);
  if (parts.some((p) => p.includes("\0"))) throw new ArchiveError(`Invalid file name in archive`);
  return parts.length ? parts.join("/") : null;
}

/** true when `target` (relative to the link's directory) stays inside root */
export function linkStaysInside(root: string, linkRel: string, target: string): boolean {
  if (path.isAbsolute(target) || target.startsWith("/")) return false;
  const resolved = path.resolve(root, path.dirname(linkRel), target);
  const r = path.resolve(root);
  return resolved === r || resolved.startsWith(r + path.sep);
}

class Writer {
  files = 0;
  dirs = 0;
  links = 0;
  bytes = 0;
  entries = 0;
  skipped: string[] = [];
  root: string;
  limits: Required<ExtractLimits>;
  constructor(root: string, limits: ExtractLimits) {
    this.root = path.resolve(root);
    this.limits = { ...DEFAULTS, ...limits };
  }
  count() {
    if (++this.entries > this.limits.maxEntries) throw new ArchiveError(`Archive has too many entries (> ${this.limits.maxEntries})`);
  }
  addBytes(n: number) {
    this.bytes += n;
    if (this.bytes > this.limits.maxBytes) throw new ArchiveError(`Archive too large when extracted (> ${Math.round(this.limits.maxBytes / 1024 ** 2)} MB)`);
  }
  abs(rel: string) {
    const a = path.resolve(this.root, rel);
    if (a !== this.root && !a.startsWith(this.root + path.sep)) throw new ArchiveError(`Path escapes root: ${rel}`);
    return a;
  }
  /** make sure no existing component of the parent path is a symlink (never write through links) */
  async ensureParent(rel: string) {
    const parts = rel.split("/").slice(0, -1);
    let cur = this.root;
    for (const p of parts) {
      cur = path.join(cur, p);
      const st = await fsp.lstat(cur).catch(() => null);
      if (!st) {
        await fsp.mkdir(cur);
        continue;
      }
      if (st.isSymbolicLink()) throw new ArchiveError(`Archive writes through a symlink: ${rel}`);
      if (!st.isDirectory()) throw new ArchiveError(`Path component is not a directory: ${rel}`);
    }
  }
  async removeExisting(abs: string) {
    const st = await fsp.lstat(abs).catch(() => null);
    if (st && !st.isDirectory()) await fsp.unlink(abs);
  }
  async dir(rel: string) {
    this.count();
    await this.ensureParent(rel + "/x");
    this.dirs++;
  }
  async file(rel: string, mode: number, source: Readable, size?: number) {
    this.count();
    if (size !== undefined && size > this.limits.maxFileBytes) throw new ArchiveError(`File too large: ${rel}`);
    await this.ensureParent(rel);
    const abs = this.abs(rel);
    await this.removeExisting(abs);
    const fileMode = mode & 0o111 ? 0o755 : 0o644;
    const out = fs.createWriteStream(abs, { mode: fileMode, flags: "wx" });
    let written = 0;
    const self = this;
    await pipeline(
      source,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          try {
            self.addBytes(chunk.length);
            if (written > self.limits.maxFileBytes) throw new ArchiveError(`File too large: ${rel}`);
          } catch (e) {
            return cb(e as Error);
          }
          out.write(chunk, cb);
        },
        final(cb) {
          out.end(cb);
        },
      }),
    );
    this.files++;
  }
  async symlink(rel: string, target: string) {
    this.count();
    if (!linkStaysInside(this.root, rel, target)) {
      this.skipped.push(`${rel} -> ${target} (symlink outside the archive)`);
      return;
    }
    await this.ensureParent(rel);
    const abs = this.abs(rel);
    await this.removeExisting(abs);
    await fsp.symlink(target, abs);
    this.links++;
  }
  async hardlink(rel: string, targetName: string) {
    this.count();
    const t = safeRelPath(targetName);
    if (!t) return;
    await this.ensureParent(rel);
    const src = this.abs(t);
    const st = await fsp.lstat(src).catch(() => null);
    if (!st || !st.isFile()) {
      this.skipped.push(`${rel} (hardlink to missing ${t})`);
      return;
    }
    const abs = this.abs(rel);
    await this.removeExisting(abs);
    await fsp.copyFile(src, abs);
    this.files++;
  }
}

// ───────────────────────────── tar ─────────────────────────────

function parseOctal(buf: Buffer, off: number, len: number): number {
  // base-256 (GNU) for big numbers
  if (buf[off]! & 0x80) {
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + buf[i]!;
    return n;
  }
  const s = buf.toString("ascii", off, off + len).replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

const cstr = (buf: Buffer, off: number, len: number) => {
  const end = buf.indexOf(0, off);
  return buf.toString("utf8", off, end >= 0 && end < off + len ? end : off + len);
};

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.toString("ascii", i, sp), 10);
    if (!len) break;
    const rec = data.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Async byte reader over a stream */
class ByteReader {
  private chunks: Buffer[] = [];
  private len = 0;
  private ended = false;
  private waiter: (() => void) | null = null;
  private err: Error | null = null;
  constructor(stream: Readable) {
    stream.on("data", (c: Buffer) => {
      this.chunks.push(c);
      this.len += c.length;
      if (this.len > 8 * 1024 * 1024) stream.pause();
      this.wake();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("error", (e) => {
      this.err = e;
      this.wake();
    });
    this.stream = stream;
  }
  stream: Readable;
  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  private async need(n: number) {
    while (this.len < n && !this.ended && !this.err) {
      if (this.stream.isPaused()) this.stream.resume();
      await new Promise<void>((r) => (this.waiter = r));
    }
    if (this.err) throw this.err;
  }
  async read(n: number): Promise<Buffer | null> {
    await this.need(n);
    if (this.len < n) return this.len === 0 ? null : this.take(this.len);
    return this.take(n);
  }
  private take(n: number) {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.len = rest.length;
    if (this.len < 4 * 1024 * 1024 && this.stream.isPaused()) this.stream.resume();
    return Buffer.from(out);
  }
  /** yields exactly n bytes in chunks */
  async *stream_(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      await this.need(1);
      if (this.len === 0) throw new ArchiveError("Unexpected end of archive");
      const take = Math.min(left, this.len, 1024 * 1024);
      yield this.take(take);
      left -= take;
    }
  }
  async skip(n: number) {
    for await (const _ of this.stream_(n)) void _;
  }
}

async function extractTarStream(input: Readable, w: Writer) {
  const r = new ByteReader(input);
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  for (;;) {
    const h = await r.read(512);
    if (!h || h.length < 512) break;
    if (h.every((b) => b === 0)) break; // end of archive
    const size = parseOctal(h, 124, 12);
    const type = String.fromCharCode(h[156]!) || "0";
    const magic = h.toString("ascii", 257, 262);
    let name = cstr(h, 0, 100);
    if (magic === "ustar") {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    let linkname = cstr(h, 157, 100);
    const mode = parseOctal(h, 100, 8);
    const padded = Math.ceil(size / 512) * 512;

    if (type === "L" || type === "K" || type === "x" || type === "g") {
      const data = (await r.read(padded))!.subarray(0, size);
      if (type === "L") longName = data.toString("utf8").replace(/\0+$/, "");
      else if (type === "K") longLink = data.toString("utf8").replace(/\0+$/, "");
      else if (type === "x") pax = parsePax(data);
      continue;
    }
    if (pax.path) name = pax.path;
    if (pax.linkpath) linkname = pax.linkpath;
    if (longName) name = longName;
    if (longLink) linkname = longLink;
    const realSize = pax.size ? Number(pax.size) : size;
    const realPadded = Math.ceil(realSize / 512) * 512;
    longName = longLink = null;
    pax = {};

    const rel = safeRelPath(name);
    if (!rel) {
      await r.skip(realPadded);
      continue;
    }
    if (type === "0" || type === "\0" || type === "7") {
      if (realSize > w.limits.maxFileBytes) throw new ArchiveError(`File too large: ${rel}`);
      const gen = r.stream_(realSize);
      await w.file(rel, mode, Readable.from(gen), realSize);
      await r.skip(realPadded - realSize);
    } else if (type === "5") {
      await w.dir(rel);
      await r.skip(realPadded);
    } else if (type === "2") {
      await w.symlink(rel, linkname);
      await r.skip(realPadded);
    } else if (type === "1") {
      await w.hardlink(rel, linkname);
      await r.skip(realPadded);
    } else {
      w.skipped.push(`${rel} (unsupported entry type ${JSON.stringify(type)})`);
      await r.skip(realPadded);
    }
  }
}

// ───────────────────────────── zip ─────────────────────────────

async function extractZip(file: string, w: Writer) {
  const fh = await fsp.open(file, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
    if (eocd < 0) throw new ArchiveError("Not a valid zip file (no end of central directory)");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // zip64
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64off = Number(tail.readBigUInt64LE(loc + 8));
        const z = Buffer.alloc(56);
        await fh.read(z, 0, 56, z64off);
        count = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cdOffset = Number(z.readBigUInt64LE(48));
      }
    }
    if (cdSize > 256 * 1024 * 1024) throw new ArchiveError("Zip central directory too large");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError("Corrupt zip central directory");
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38);
      let lho = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      // zip64 extended info
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) (usize = Number(extra.readBigUInt64LE(q)), (q += 8));
          if (csize === 0xffffffff) (csize = Number(extra.readBigUInt64LE(q)), (q += 8));
          if (lho === 0xffffffff) lho = Number(extra.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;

      const rel = safeRelPath(name);
      if (!rel) continue;
      const unixMode = madeBy === 3 ? ext >>> 16 : 0;
      const isDir = name.endsWith("/") || (unixMode & 0o170000) === 0o040000;
      const isLink = (unixMode & 0o170000) === 0o120000;
      if (isDir) {
        await w.dir(rel);
        continue;
      }
      if (usize > w.limits.maxFileBytes) throw new ArchiveError(`File too large: ${rel}`);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError("Corrupt zip local header");
      const dataStart = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const raw = fs.createReadStream(file, { start: dataStart, end: dataStart + Math.max(csize, 1) - 1 });
      let src: Readable;
      if (method === 0) src = raw;
      else if (method === 8) src = raw.pipe(zlib.createInflateRaw());
      else {
        w.skipped.push(`${rel} (unsupported zip compression ${method})`);
        raw.destroy();
        continue;
      }
      if (csize === 0) {
        raw.destroy();
        src = Readable.from([]);
      }
      if (isLink) {
        const chunks: Buffer[] = [];
        for await (const c of src) chunks.push(c as Buffer);
        await w.symlink(rel, Buffer.concat(chunks).toString("utf8"));
      } else {
        await w.file(rel, unixMode || 0o644, src, usize);
      }
    }
  } finally {
    await fh.close();
  }
}

// ───────────────────────────── entry ─────────────────────────────

export async function sniffArchive(file: string): Promise<"tar.gz" | "zip" | "tar" | null> {
  const fh = await fsp.open(file, "r");
  try {
    const b = Buffer.alloc(512);
    const { bytesRead } = await fh.read(b, 0, 512, 0);
    if (bytesRead >= 2 && b[0] === 0x1f && b[1] === 0x8b) return "tar.gz";
    if (bytesRead >= 4 && b.readUInt32LE(0) === 0x04034b50) return "zip";
    if (bytesRead >= 4 && b.readUInt32LE(0) === 0x06054b50) return "zip"; // empty zip
    if (bytesRead >= 262 && b.toString("ascii", 257, 262) === "ustar") return "tar";
    return null;
  } finally {
    await fh.close();
  }
}

/** Extract `file` (tar / tar.gz / zip) into `dest` (created). */
export async function extractArchive(file: string, dest: string, limits: ExtractLimits = {}): Promise<ExtractResult> {
  const format = await sniffArchive(file);
  if (!format) throw new ArchiveError("Unsupported archive format (expected .tar.gz, .tar or .zip)");
  await fsp.mkdir(dest, { recursive: true });
  const w = new Writer(dest, limits);
  if (format === "zip") await extractZip(file, w);
  else {
    const raw = fs.createReadStream(file);
    const stream = format === "tar.gz" ? raw.pipe(zlib.createGunzip()) : raw;
    raw.on("error", (e) => stream.destroy(e));
    await extractTarStream(stream, w);
    raw.destroy();
  }
  return { files: w.files, dirs: w.dirs, links: w.links, bytes: w.bytes, skipped: w.skipped, format };
}

/** If the archive has a single top-level directory (GitHub zipballs, `tar czf app.tgz app/`), return it. */
export async function singleTopDir(dir: string): Promise<string | null> {
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.name !== "__MACOSX" && e.name !== ".DS_Store");
  if (entries.length === 1 && entries[0]!.isDirectory()) return path.join(dir, entries[0]!.name);
  return null;
}
