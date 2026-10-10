import pkg from "../../../package.json";
import { redis } from "@/lib/redis";
import { getSetting } from "@/lib/settings";

/**
 * Platform version + "update available" check (ops area).
 * The running version comes from LEVANT_VERSION (image build arg) or control/package.json.
 * The update source is the `updates.checkUrl` setting (or env LEVANT_UPDATE_URL). It may return:
 *   - JSON `{ "version": "1.2.0", "notes": "…", "url": "https://…" }`
 *   - a GitHub "latest release" API response (`tag_name`, `body`, `html_url`)
 *   - plain text whose first line is the version
 * Worker-safe (no Next imports).
 */
export type UpdateInfo = {
  current: string;
  latest: string | null;
  available: boolean;
  notes: string | null;
  url: string | null;
  source: string | null;
  checkedAt: string | null;
  error: string | null;
};

const CACHE_KEY = "ld:ops:update";
const CACHE_TTL = 6 * 3600;

export function currentVersion(): string {
  return process.env.LEVANT_VERSION?.trim() || (pkg as { version: string }).version;
}

/** Compare two versions ("v1.2.3", "1.2.3-rc.1"). Returns <0, 0, >0. A pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

export async function updateSource(): Promise<string | null> {
  return (await getSetting("updates.checkUrl")) || process.env.LEVANT_UPDATE_URL?.trim() || null;
}

/** Parses a version-file response body. Exported for tests. */
export function parseVersionDoc(body: string, contentType = ""): { version: string; notes: string | null; url: string | null } | null {
  const text = body.trim();
  if (!text) return null;
  if (contentType.includes("json") || text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const version = (j.version ?? j.tag_name ?? j.latest ?? j.name) as unknown;
      if (typeof version !== "string" || !version.trim()) return null;
      const notes = (j.notes ?? j.body ?? null) as unknown;
      const url = (j.url ?? j.html_url ?? null) as unknown;
      return { version: version.trim(), notes: typeof notes === "string" ? notes.slice(0, 4000) : null, url: typeof url === "string" ? url : null };
    } catch {
      return null;
    }
  }
  const first = text.split(/\r?\n/)[0].trim();
  return /^v?\d+(\.\d+){0,3}([-+][\w.]+)?$/.test(first) ? { version: first, notes: null, url: null } : null;
}

export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<UpdateInfo> {
  const current = currentVersion();
  if (!opts.force) {
    const raw = await redis()
      .get(CACHE_KEY)
      .catch(() => null);
    if (raw) {
      try {
        const c = JSON.parse(raw) as UpdateInfo;
        if (c.current === current) return c;
      } catch {}
    }
  }
  const source = await updateSource();
  const info: UpdateInfo = { current, latest: null, available: false, notes: null, url: null, source, checkedAt: new Date().toISOString(), error: null };
  if (!source) {
    info.error = "No update source configured";
    info.checkedAt = null;
    return info;
  }
  try {
    const r = await fetch(source, { headers: { accept: "application/json, text/plain;q=0.9", "user-agent": `LevantDeploy/${current}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const doc = parseVersionDoc(await r.text(), r.headers.get("content-type") || "");
    if (!doc) throw new Error("The version file is not valid (expected JSON {version} or a version string)");
    info.latest = doc.version;
    info.notes = doc.notes;
    info.url = doc.url;
    info.available = compareVersions(doc.version, current) > 0;
  } catch (e) {
    info.error = (e as Error).name === "TimeoutError" ? "Timed out" : (e as Error).message;
  }
  await redis()
    .set(CACHE_KEY, JSON.stringify(info), "EX", info.error ? 600 : CACHE_TTL)
    .catch(() => {});
  return info;
}
