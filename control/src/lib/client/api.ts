"use client";

/** Client-side fetch helper for /api/v1/**. Throws ApiClientError with the server's {code, message, fields}. */
export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    /** the whole server error object (e.g. PLAN_LIMIT: { resource, limit, used, plan, upgradeUrl }) */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Fired on window for every PLAN_LIMIT / EMAIL_UNVERIFIED API error — <PlanLimitListener/> shows a banner linking to Plan & Usage. */
export const PLAN_LIMIT_EVENT = "ld:plan-limit";

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null)?.error;
    if ((err?.code === "PLAN_LIMIT" || err?.code === "EMAIL_UNVERIFIED") && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PLAN_LIMIT_EVENT, { detail: err }));
    }
    throw new ApiClientError(res.status, err?.code ?? "HTTP_" + res.status, err?.message ?? `Request failed (${res.status})`, err?.fields, (err as Record<string, unknown> | undefined) ?? undefined);
  }
  return data as T;
}
