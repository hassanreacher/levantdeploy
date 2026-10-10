import { readConfig, normalizeServer } from "./config.js";

export class CliError extends Error {
  constructor(
    message: string,
    public status = 1,
    public code?: string,
  ) {
    super(message);
  }
}

export type ClientOpts = { server?: string; token?: string };

/** Thin REST client for /api/v1 (Bearer token). */
export class Client {
  readonly server: string;
  readonly token: string | null;
  constructor(opts: ClientOpts = {}) {
    const cfg = readConfig();
    const server = opts.server || process.env.LEVANT_SERVER || cfg.server;
    if (!server) throw new CliError("No server configured. Run `levant login --server https://deploy.example.com` first.");
    this.server = normalizeServer(server);
    this.token = opts.token || process.env.LEVANT_TOKEN || cfg.token || null;
  }

  requireToken() {
    if (!this.token) throw new CliError("Not logged in. Run `levant login`.", 1, "UNAUTHORIZED");
  }

  async request<T = any>(method: string, path: string, opts: { body?: unknown; raw?: BodyInit | Uint8Array; headers?: Record<string, string>; query?: Record<string, string | number | undefined>; auth?: boolean; text?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(this.server + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { "user-agent": "levant-cli", ...(opts.headers ?? {}) };
    if (opts.auth !== false) {
      this.requireToken();
      headers.authorization = `Bearer ${this.token}`;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: (opts.raw as BodyInit | undefined) ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined), signal: opts.signal });
    } catch (e) {
      throw new CliError(`Could not reach ${this.server}: ${(e as Error & { cause?: Error }).cause?.message ?? (e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = `${method} ${path} failed (${res.status})`;
      let code: string | undefined;
      try {
        const j = JSON.parse(text) as { error?: { message?: string; code?: string; fields?: Record<string, string> }; status?: string };
        if (j.error?.message) msg = j.error.message + (j.error.fields ? ` (${Object.entries(j.error.fields).map(([k, v]) => `${k}: ${v}`).join(", ")})` : "");
        code = j.error?.code ?? j.status;
      } catch {}
      if (res.status === 401) msg += " — run `levant login`";
      throw new CliError(msg, res.status, code);
    }
    if (opts.text) return text as T;
    return (text ? JSON.parse(text) : null) as T;
  }
}
