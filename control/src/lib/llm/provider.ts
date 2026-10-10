import { LlmError, type LlmChatRequest, type LlmErrorCode, type LlmFinishReason, type LlmLimits, type LlmModelInfo, type LlmProviderKind, type LlmUsageCounts } from "./types";

/** A provider ready to be called (key resolved). Server-only — contains the plain key. */
export type ResolvedProvider = {
  id: string;
  label: string;
  kind: LlmProviderKind;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  configured: boolean;
  jsonMode: "schema" | "object" | "none";
  modelsEndpoint: boolean;
  rotate: boolean;
  limits: LlmLimits;
  /** curated models the router may pick on its own (builtin/manual; fetched ones too for rotation providers) */
  models: LlmModelInfo[];
  /** every enabled model incl. fetched ones (reachable by explicit "provider/model" refs) */
  allModels: LlmModelInfo[];
  warning?: string;
};

export type RawToolCall = { id?: string; name: string; arguments: string; extra?: Record<string, unknown> };

export type AdapterInput = {
  provider: ResolvedProvider;
  model: LlmModelInfo;
  req: LlmChatRequest;
  signal: AbortSignal;
  stream: boolean;
  /** text delta */
  onText: (t: string) => void;
  /** any chunk arrived (resets the idle timer) */
  onActivity: () => void;
};

export type AdapterOutput = {
  text: string;
  toolCalls: RawToolCall[];
  finishReason: LlmFinishReason;
  usage: LlmUsageCounts;
};

export type Adapter = (i: AdapterInput) => Promise<AdapterOutput>;

const HIGH_DEMAND = /high demand|overloaded|over capacity|capacity|try again later|temporarily unavailable|unavailable/i;
const QUOTA = /quota|rate.?limit|too many requests|exceeded|resource.?exhausted|limit reached/i;

/** Parse Retry-After (seconds or HTTP date) or hints in the body ("retryDelay": "30s", "try again in 20s", "in 1m30s"). */
export function parseRetryAfter(headers: Headers | null, body: string): number | undefined {
  const h = headers?.get("retry-after") ?? headers?.get("x-ratelimit-reset-requests") ?? null;
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const m = h.match(/^(?:(\d+)m)?(?:([\d.]+)s)?$/);
    if (m && (m[1] || m[2])) return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
    const d = Date.parse(h);
    if (Number.isFinite(d)) return Math.max(0, d - Date.now());
  }
  const b = body.match(/retry[_ ]?delay"?\s*[:=]\s*"?([\d.]+)s/i) ?? body.match(/(?:try again|retry) (?:in|after) ([\d.]+)\s*(?:s|sec|seconds)\b/i);
  if (b) return Number(b[1]) * 1000;
  const mm = body.match(/(?:try again|retry) (?:in|after) (\d+)m([\d.]+)s/i);
  if (mm) return (Number(mm[1]) * 60 + Number(mm[2])) * 1000;
  return undefined;
}

/** Map an HTTP failure to an LlmError. */
export function classifyHttp(status: number, body: string, headers: Headers | null, ctx: { provider: string; model: string }): LlmError {
  const msg = extractMessage(body) || `HTTP ${status}`;
  const retryAfterMs = parseRetryAfter(headers, body);
  let code: LlmErrorCode;
  if (status === 429) code = "RATE_LIMITED";
  else if (status === 503 || status === 529) code = QUOTA.test(msg) && !HIGH_DEMAND.test(msg) ? "RATE_LIMITED" : "OVERLOADED";
  else if (status === 401) code = "AUTH";
  else if (status === 403) code = QUOTA.test(msg) ? "RATE_LIMITED" : "AUTH";
  else if (status === 402) code = "RATE_LIMITED"; // out of credits
  else if (status === 404) code = "NOT_FOUND";
  else if (status === 408 || status === 504) code = "TIMEOUT";
  else if (status >= 500) code = HIGH_DEMAND.test(msg) ? "OVERLOADED" : "SERVER";
  else if (QUOTA.test(msg) && /quota|exceeded|rate/i.test(msg)) code = "RATE_LIMITED";
  else code = "BAD_REQUEST";
  return new LlmError(code, `${ctx.provider}/${ctx.model}: ${truncate(msg, 300)}`, { status, retryAfterMs, provider: ctx.provider, model: ctx.model });
}

export function extractMessage(body: string): string {
  try {
    const j = JSON.parse(body) as unknown;
    const pick = (o: unknown): string | null => {
      if (!o) return null;
      if (typeof o === "string") return o;
      if (Array.isArray(o)) return pick(o[0]);
      if (typeof o === "object") {
        const r = o as Record<string, unknown>;
        return pick(r.error) ?? (typeof r.message === "string" ? r.message : null) ?? (typeof r.detail === "string" ? r.detail : null);
      }
      return null;
    };
    return pick(j) ?? body.slice(0, 300);
  } catch {
    return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  }
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Strip anything looking like a key from an error message (defence in depth before logging/storing). */
export function scrubSecrets(s: string, keys: (string | null | undefined)[] = []): string {
  let out = s;
  for (const k of keys) if (k && k.length >= 8) out = out.split(k).join(`••••${k.slice(-4)}`);
  return out
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}|nvapi-[A-Za-z0-9_-]{8,})/g, (m) => `••••${m.slice(-4)}`)
    .replace(/(key=)[^&\s"]+/gi, "$1••••");
}
