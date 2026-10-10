import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import type { LogStream } from "@prisma/client";
import { db } from "@/lib/db";
import { redis, newRedis } from "@/lib/redis";

/**
 * Deployment logs.
 *  - live:     Redis stream `ld:logs:{deploymentId}:{stream}` (XADD, capped) + PUBLISH on `ld:logs:pub:{deploymentId}:{stream}`
 *  - archived: gzip file STORAGE_DIR/logs/{deploymentId}.log.gz (BUILD) / {deploymentId}.runtime.log.gz (RUNTIME), row in LogArchive
 *
 * Producers:  await appendLog(id, "BUILD", "Step 1/9 : FROM node:22")   (multi-line strings are split)
 *             await endLogs(id, "BUILD")                                 (tells SSE followers the stream is finished)
 *             await archiveLogs(id, "BUILD")                             (after the build; also done by cleanup)
 * Consumers:  readLogs(id, "BUILD", { from, limit })                     (JSON pagination)
 *             logStreamResponse(id, "BUILD", { signal, from })           (SSE for the LogViewer)
 */

export type LogLine = { id: string; ts: number; line: string };

const MAX_LINE = 8192;
const MAX_LINES = Number(process.env.LOG_MAX_LINES || 50_000);

export const logKey = (deploymentId: string, stream: LogStream) => `ld:logs:${deploymentId}:${stream}`;
export const logChannel = (deploymentId: string, stream: LogStream) => `ld:logs:pub:${deploymentId}:${stream}`;
const endKey = (deploymentId: string, stream: LogStream) => `ld:logs:end:${deploymentId}:${stream}`;

function storageDir() {
  return path.resolve(process.env.STORAGE_DIR || "./storage");
}

export function archivePath(deploymentId: string, stream: LogStream) {
  return path.join("logs", stream === "BUILD" ? `${deploymentId}.log.gz` : `${deploymentId}.runtime.log.gz`);
}

/** Append one or more lines (string with \n, or array). Returns the stream ids written. */
export async function appendLog(deploymentId: string, stream: LogStream, text: string | string[]): Promise<string[]> {
  const lines = (Array.isArray(text) ? text : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")).map((l) =>
    l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l,
  );
  if (!lines.length) return [];
  const r = redis();
  const key = logKey(deploymentId, stream);
  const ts = Date.now();
  const pipe = r.pipeline();
  for (const l of lines) pipe.xadd(key, "MAXLEN", "~", String(MAX_LINES), "*", "t", String(ts), "l", l);
  pipe.expire(key, 14 * 86400);
  const res = await pipe.exec();
  const ids = (res ?? []).slice(0, lines.length).map((x) => String(x?.[1] ?? ""));
  const payload = lines.map((l, i) => ({ id: ids[i]!, ts, line: l }));
  await r.publish(logChannel(deploymentId, stream), JSON.stringify(payload)).catch(() => {});
  return ids;
}

/** Mark the stream finished (SSE followers receive `event: end` and close). */
export async function endLogs(deploymentId: string, stream: LogStream) {
  const r = redis();
  await r.set(endKey(deploymentId, stream), "1", "EX", 14 * 86400);
  await r.xadd(logKey(deploymentId, stream), "*", "t", String(Date.now()), "e", "1");
  await r.publish(logChannel(deploymentId, stream), JSON.stringify({ end: true })).catch(() => {});
}

export async function isLogEnded(deploymentId: string, stream: LogStream) {
  return (await redis().exists(endKey(deploymentId, stream))) === 1;
}

function parseEntries(entries: Array<[string, string[]]>): { lines: LogLine[]; ended: boolean } {
  const lines: LogLine[] = [];
  let ended = false;
  for (const [id, fields] of entries) {
    const f: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
    if (f.e) {
      ended = true;
      continue;
    }
    lines.push({ id, ts: Number(f.t) || 0, line: f.l ?? "" });
  }
  return { lines, ended };
}

/** Exclusive start id for XRANGE. */
function after(id: string) {
  const [ms, seq] = id.split("-");
  return `${ms}-${Number(seq ?? 0) + 1}`;
}

/**
 * Read lines after `from` (stream id, exclusive; omit for the beginning). Falls back to the archive.
 * For archived logs ids are "a-<lineNo>".
 */
export async function readLogs(
  deploymentId: string,
  stream: LogStream,
  opts: { from?: string; limit?: number } = {},
): Promise<{ lines: LogLine[]; next: string | null; ended: boolean; source: "live" | "archive" | "none" }> {
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
  const r = redis();
  const key = logKey(deploymentId, stream);
  if ((await r.exists(key)) === 1) {
    const start = opts.from && !opts.from.startsWith("a-") ? after(opts.from) : "-";
    const entries = (await r.xrange(key, start, "+", "COUNT", limit)) as Array<[string, string[]]>;
    const { lines, ended } = parseEntries(entries);
    const last = entries.length ? entries[entries.length - 1]![0] : (opts.from ?? null);
    return { lines, next: last, ended: ended || (await isLogEnded(deploymentId, stream)), source: "live" };
  }
  const arch = await db.logArchive.findUnique({ where: { deploymentId_stream: { deploymentId, stream } } });
  if (!arch) return { lines: [], next: opts.from ?? null, ended: false, source: "none" };
  const skip = opts.from?.startsWith("a-") ? Number(opts.from.slice(2)) : 0;
  const lines: LogLine[] = [];
  let n = 0;
  for await (const l of readArchive(arch.path)) {
    n++;
    if (n <= skip) continue;
    lines.push({ ...l, id: `a-${n}` });
    if (lines.length >= limit) break;
  }
  return { lines, next: lines.length ? lines[lines.length - 1]!.id : (opts.from ?? null), ended: lines.length < limit, source: "archive" };
}

async function* readArchive(rel: string): AsyncGenerator<{ ts: number; line: string }> {
  const file = path.join(storageDir(), rel);
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const raw of rl) {
    const tab = raw.indexOf("\t");
    yield tab > 0 ? { ts: Number(raw.slice(0, tab)) || 0, line: raw.slice(tab + 1) } : { ts: 0, line: raw };
  }
}

/**
 * Write the whole Redis stream to a gzip file (`<epochMs>\t<line>` per line), upsert LogArchive,
 * and let the Redis key expire after `keepLiveSeconds` (default 1h, so open viewers finish cleanly).
 */
export async function archiveLogs(deploymentId: string, stream: LogStream, opts: { keepLiveSeconds?: number } = {}) {
  const r = redis();
  const key = logKey(deploymentId, stream);
  const rel = archivePath(deploymentId, stream);
  const file = path.join(storageDir(), rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(file);
  gz.pipe(out);
  let count = 0;
  let cursor = "-";
  for (;;) {
    const entries = (await r.xrange(key, cursor, "+", "COUNT", 5000)) as Array<[string, string[]]>;
    if (!entries.length) break;
    const { lines } = parseEntries(entries);
    for (const l of lines) {
      gz.write(`${l.ts}\t${l.line.replace(/\n/g, " ")}\n`);
      count++;
    }
    cursor = after(entries[entries.length - 1]![0]);
    if (entries.length < 5000) break;
  }
  gz.end();
  await new Promise<void>((res, rej) => {
    out.on("finish", () => res());
    out.on("error", rej);
  });
  const size = (await fs.promises.stat(file)).size;
  await db.logArchive.upsert({
    where: { deploymentId_stream: { deploymentId, stream } },
    create: { deploymentId, stream, path: rel, sizeBytes: size, lineCount: count },
    update: { path: rel, sizeBytes: size, lineCount: count },
  });
  await r.expire(key, opts.keepLiveSeconds ?? 3600);
  return { path: rel, sizeBytes: size, lineCount: count };
}

/** Delete live + archived logs (cleanup). */
export async function deleteLogs(deploymentId: string) {
  const r = redis();
  for (const s of ["BUILD", "RUNTIME"] as LogStream[]) {
    await r.del(logKey(deploymentId, s), endKey(deploymentId, s));
    await fs.promises.rm(path.join(storageDir(), archivePath(deploymentId, s)), { force: true });
  }
  await db.logArchive.deleteMany({ where: { deploymentId } });
}

/**
 * Server-Sent Events response streaming a deployment log.
 * Events: default `message` with data `{"id","ts","line"}` (id also in the SSE `id:` field → Last-Event-ID resume),
 *         `event: end` when the stream is finished, `: ping` comments every 15 s.
 * The route handler is responsible for access checks.
 */
export function logStreamResponse(
  deploymentId: string,
  stream: LogStream,
  opts: { signal?: AbortSignal; from?: string | null; follow?: boolean } = {},
): Response {
  const enc = new TextEncoder();
  const follow = opts.follow !== false;
  let closed = false;
  let blocking: ReturnType<typeof newRedis> | null = null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const sendLines = (lines: LogLine[]) => {
        if (!lines.length) return;
        let buf = "";
        for (const l of lines) buf += `id: ${l.id}\ndata: ${JSON.stringify(l)}\n\n`;
        send(buf);
      };
      const finish = () => {
        if (closed) return;
        send(`event: end\ndata: {}\n\n`);
        closed = true;
        try {
          controller.close();
        } catch {}
        void blocking?.quit().catch(() => {});
      };
      opts.signal?.addEventListener("abort", () => {
        closed = true;
        void blocking?.quit().catch(() => {});
        try {
          controller.close();
        } catch {}
      });
      send(`retry: 3000\n: connected\n\n`);
      const ping = setInterval(() => send(`: ping\n\n`), 15_000);
      try {
        // 1) backlog
        let cursor = opts.from ?? undefined;
        for (;;) {
          const page = await readLogs(deploymentId, stream, { from: cursor, limit: 2000 });
          sendLines(page.lines);
          cursor = page.next ?? cursor;
          if (page.source !== "live") {
            if (page.lines.length === 2000) continue;
            // archived (finished) or nothing yet
            if (page.source === "archive" || !follow) return finish();
            break;
          }
          if (page.lines.length < 2000) {
            if (page.ended || !follow) return finish();
            break;
          }
        }
        // 2) follow with XREAD BLOCK on a dedicated connection
        blocking = newRedis();
        let last = cursor && !cursor.startsWith("a-") ? cursor : "0-0";
        const key = logKey(deploymentId, stream);
        while (!closed) {
          const res = (await blocking.xread("COUNT", 1000, "BLOCK", 10_000, "STREAMS", key, last).catch(() => null)) as
            | Array<[string, Array<[string, string[]]>]>
            | null;
          if (closed) break;
          if (!res) {
            if (await isLogEnded(deploymentId, stream)) return finish();
            continue;
          }
          const entries = res[0]?.[1] ?? [];
          if (!entries.length) continue;
          last = entries[entries.length - 1]![0];
          const { lines, ended } = parseEntries(entries);
          sendLines(lines);
          if (ended) return finish();
        }
      } catch (e) {
        console.warn("[logs:sse]", (e as Error).message);
        finish();
      } finally {
        clearInterval(ping);
      }
    },
    cancel() {
      closed = true;
      void blocking?.quit().catch(() => {});
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
