import { PassThrough, type Readable } from "node:stream";
import { db } from "@/lib/db";
import { docker } from "@/lib/docker";
import { appendLog } from "@/lib/logs";
import { newRedis, redis } from "@/lib/redis";
import { STATUS_CHANNEL } from "@/lib/deployments";
import { containerRefs, inspectSafe, type ContainerRef } from "./containers";

/**
 * Runtime log follower (runs inside the worker):
 *  - follows `docker logs -f` of every replica of every live deployment (READY/SUPERSEDED, not stopped)
 *  - prefixes lines with the replica (`[r1]`, or `[web]` for compose services) and appends them to the RUNTIME stream
 *  - batches (≤ 300 ms / 500 lines), bounded buffer (drops oldest beyond 5000 lines and says so)
 *  - reconnects when a container restarts; resumes from the last seen docker timestamp (no duplicates after a worker restart)
 *  - reconciles every 10 s and on every deployment status event
 */

const MAX_BUFFER = 5000;
const tsKey = (containerId: string) => `ld:rtlog:ts:${containerId}`;

/** RFC3339Nano → sortable fixed-width string "<epochSeconds>.<9 digits>" (pure, tested). */
export function sortableTs(ts: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) return null;
  const sec = Math.floor(Date.parse(`${m[1]}${m[3]}`) / 1000);
  if (!Number.isFinite(sec)) return null;
  return `${String(sec).padStart(11, "0")}.${(m[2] ?? "").padEnd(9, "0")}`;
}

/** Split "2024-01-01T00:00:00.123Z message" → [ts, message]. */
export function splitTimestamp(line: string): [string | null, string] {
  const sp = line.indexOf(" ");
  if (sp > 0 && /^\d{4}-\d{2}-\d{2}T/.test(line)) return [line.slice(0, sp), line.slice(sp + 1)];
  return [null, line];
}

class Follower {
  private stopped = false;
  private stream: Readable | null = null;
  private buffer: string[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastTs: string | null = null;
  constructor(
    public deploymentId: string,
    public ref: ContainerRef,
  ) {}

  get prefix() {
    return this.ref.service ? `[${this.ref.service}${this.ref.replica > 1 ? `-${this.ref.replica}` : ""}]` : `[r${this.ref.replica}]`;
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    try {
      (this.stream as unknown as { destroy?: () => void })?.destroy?.();
    } catch {}
    void this.flush();
  }

  private push(line: string) {
    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER) {
      const n = this.buffer.length - MAX_BUFFER;
      this.buffer.splice(0, n);
      this.dropped += n;
    }
    if (this.buffer.length >= 500) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 300);
  }

  private async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer.length && !this.dropped) return;
    const lines = this.buffer.splice(0);
    if (this.dropped) {
      lines.unshift(`${this.prefix} [levant] ${this.dropped} log lines dropped (output too fast)`);
      this.dropped = 0;
    }
    await appendLog(this.deploymentId, "RUNTIME", lines).catch(() => {});
    if (this.lastTs) await redis().set(tsKey(this.ref.id), this.lastTs, "EX", 7 * 86400).catch(() => {});
  }

  private async loop() {
    let backoff = 1000;
    this.lastTs = await redis()
      .get(tsKey(this.ref.id))
      .catch(() => null);
    while (!this.stopped) {
      const info = await inspectSafe(this.ref.id);
      if (!info) return; // container removed → reconcile drops us
      if (!info.State.Running) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      try {
        const since = this.lastTs ? this.lastTs.replace(/^0+/, "") : String(Math.floor(new Date(info.Created).getTime() / 1000));
        const stream = (await docker()
          .getContainer(this.ref.id)
          .logs({ follow: true, stdout: true, stderr: true, timestamps: true, since: since as unknown as number })) as unknown as Readable;
        this.stream = stream;
        backoff = 1000;
        await this.consume(stream, !!info.Config.Tty);
      } catch {
        // fallthrough → retry
      }
      await this.flush();
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  private consume(stream: Readable, tty: boolean): Promise<void> {
    return new Promise((resolve) => {
      const out = new PassThrough();
      if (tty) stream.pipe(out);
      else docker().modem.demuxStream(stream, out, out);
      let partial = "";
      out.on("data", (b: Buffer) => {
        partial += b.toString("utf8");
        const parts = partial.split("\n");
        partial = parts.pop() ?? "";
        for (const raw of parts) this.handle(raw.replace(/\r$/, ""));
      });
      const done = () => {
        if (partial) this.handle(partial);
        partial = "";
        resolve();
      };
      stream.on("end", done);
      stream.on("close", done);
      stream.on("error", done);
    });
  }

  private handle(raw: string) {
    const [ts, msg] = splitTimestamp(raw);
    if (ts) {
      const s = sortableTs(ts);
      if (s && this.lastTs && s <= this.lastTs) return; // already appended before a reconnect
      if (s) this.lastTs = s;
    }
    this.push(`${this.prefix} ${msg}`);
  }
}

const g = globalThis as unknown as { __ldLogFollowers?: Map<string, Follower>; __ldLogTimer?: NodeJS.Timeout };
const followers = (g.__ldLogFollowers ??= new Map());

/** Bring the set of followers in line with the DB (live deployments). */
export async function reconcileLogFollowers() {
  const live = await db.deployment.findMany({
    where: { status: { in: ["READY", "SUPERSEDED"] }, stoppedAt: null },
    select: { id: true, containerIds: true },
  });
  const want = new Map<string, { depId: string; ref: ContainerRef }>();
  for (const d of live) for (const r of containerRefs(d as never)) want.set(r.id, { depId: d.id, ref: r });
  for (const [cid, f] of followers) {
    if (!want.has(cid)) {
      f.stop();
      followers.delete(cid);
    }
  }
  for (const [cid, w] of want) {
    if (followers.has(cid)) continue;
    const f = new Follower(w.depId, w.ref);
    followers.set(cid, f);
    f.start();
  }
  return { following: followers.size };
}

/** Called once by the worker: periodic reconcile + immediate reconcile on deployment status events. */
export function startLogFollowers() {
  if (g.__ldLogTimer) return;
  void reconcileLogFollowers().catch((e) => console.warn("[runtime-logs]", (e as Error).message));
  g.__ldLogTimer = setInterval(() => void reconcileLogFollowers().catch(() => {}), 10_000);
  const sub = newRedis();
  void sub.subscribe(STATUS_CHANNEL, "ld:runtime:changed").catch(() => {});
  let t: NodeJS.Timeout | null = null;
  sub.on("message", () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      void reconcileLogFollowers().catch(() => {});
    }, 500);
  });
}

export function stopLogFollowers() {
  if (g.__ldLogTimer) clearInterval(g.__ldLogTimer);
  g.__ldLogTimer = undefined;
  for (const f of followers.values()) f.stop();
  followers.clear();
}
