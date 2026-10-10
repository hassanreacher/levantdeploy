/**
 * Upstream image versions (base-stack/upstream/docker-compose.yml @ UPSTREAM.txt). A unit test checks that these match
 * the vendored upstream compose file, so updating upstream = re-vendor + bump here (see base-stack/README.md).
 * Stored per project in BaseProject.versions (so an upgrade is explicit: `stackAction(ref, "upgrade", { versions })`).
 */
export const DEFAULT_VERSIONS = {
  studio: "supabase/studio:2026.09.07-sha-7996410",
  gateway: "envoyproxy/envoy:v1.39.1",
  auth: "supabase/gotrue:v2.196.0",
  rest: "postgrest/postgrest:v14.17",
  realtime: "supabase/realtime:v2.134.10",
  storage: "supabase/storage-api:v1.74.0",
  imgproxy: "darthsim/imgproxy:v3.31.4",
  meta: "supabase/postgres-meta:v0.99.0",
  functions: "supabase/edge-runtime:v1.76.2",
  db: "supabase/postgres:17.6.1.136",
  pooler: "supabase/supavisor:2.9.12",
} as const;

export type VersionKey = keyof typeof DEFAULT_VERSIONS;
export type BaseVersions = Record<VersionKey, string>;
export const VERSION_KEYS = Object.keys(DEFAULT_VERSIONS) as VersionKey[];

const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/]*:[A-Za-z0-9._\-]+$/;

/** Stored versions (may be partial / from an older release) merged over the defaults, validated. */
export function resolveVersions(stored: unknown, override?: Partial<Record<string, string>>): BaseVersions {
  const out: BaseVersions = { ...DEFAULT_VERSIONS };
  for (const src of [stored, override]) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if ((VERSION_KEYS as string[]).includes(k) && typeof v === "string" && IMAGE_RE.test(v)) out[k as VersionKey] = v;
    }
  }
  return out;
}

/** Docker Hub image → optional mirror prefix ("mirror.gcr.io" → mirror.gcr.io/supabase/postgres:…). */
export function imageRef(image: string, mirror?: string | null): string {
  const m = (mirror ?? "").trim().replace(/\/+$/, "");
  if (!m) return image;
  const first = image.split("/")[0]!;
  const hasRegistry = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry) return image; // already fully qualified
  return `${m}/${image.includes("/") ? image : `library/${image}`}`;
}
