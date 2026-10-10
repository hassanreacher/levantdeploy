import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { ZodError, type ZodTypeAny, type z } from "zod";
import type { Project, Team, TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { getSession, type SessionUser } from "@/lib/auth/session";
import { verifyApiToken, tokenHasScope } from "@/lib/auth/tokens";
import { hasRole } from "@/lib/auth/roles";
import { rateLimit, LIMITS } from "@/lib/rate-limit";

/**
 * REST conventions for /api/v1/**:
 *  - success: HTTP 2xx, body = the payload object itself (never wrapped)
 *  - error:   HTTP 4xx/5xx, body = { error: { code, message, fields? } }
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const E = {
  unauthorized: (m = "Please sign in") => new ApiError(401, "UNAUTHORIZED", m),
  forbidden: (m = "You don't have access to this resource") => new ApiError(403, "FORBIDDEN", m),
  notFound: (m = "Not found") => new ApiError(404, "NOT_FOUND", m),
  bad: (m: string, fields?: Record<string, string>) => new ApiError(400, "BAD_REQUEST", m, fields),
  validation: (fields: Record<string, string>, m = "Please check the highlighted fields") => new ApiError(422, "VALIDATION", m, fields),
  conflict: (m: string) => new ApiError(409, "CONFLICT", m),
  tooMany: (resetIn = 60) => new ApiError(429, "RATE_LIMITED", `Too many requests. Try again in ${resetIn}s`),
  unavailable: (m = "Service unavailable") => new ApiError(503, "UNAVAILABLE", m),
  internal: (m = "Something went wrong. Please try again.") => new ApiError(500, "SERVER_ERROR", m),
};

/** JSON response. `json(data)`, `json(data, 201)`, `json(data, { headers })`. BigInt is serialised as string. */
export function json<T>(data: T, init?: number | ResponseInit) {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const ri: ResponseInit = typeof init === "number" ? { status: init } : (init ?? {});
  const h = new Headers(ri.headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new NextResponse(body, { ...ri, headers: h });
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } }, { status: err.status });
  }
  // worker-safe libs (e.g. src/lib/plans PlanLimitError → 402 PLAN_LIMIT) expose publicError() instead of extending ApiError
  if (err instanceof Error && typeof (err as { publicError?: unknown }).publicError === "function") {
    const p = (err as unknown as { publicError(): { status: number; body: Record<string, unknown> } }).publicError();
    return NextResponse.json({ error: p.body }, { status: p.status });
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const i of err.issues) fields[i.path.join(".") || "_"] ??= i.message;
    return NextResponse.json({ error: { code: "VALIDATION", message: "Please check the highlighted fields", fields } }, { status: 422 });
  }
  // Next.js control-flow errors (redirect/notFound) must propagate
  if (err && typeof err === "object" && "digest" in err && typeof (err as { digest: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_")) throw err;
  console.error("[api] unhandled", err);
  return NextResponse.json({ error: { code: "SERVER_ERROR", message: "Something went wrong. Please try again." } }, { status: 500 });
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("cf-connecting-ip") || h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

export type RouteCtx<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };
type Handler<P extends Record<string, string>> = (req: Request, ctx: RouteCtx<P>) => Promise<Response>;

/**
 * Wraps a route handler: per-IP rate limit + uniform error handling.
 *   export const GET = route<{ id: string }>(async (req, { params }) => { const { id } = await params; ... });
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  fn: Handler<P>,
  opts: { limit?: { limit: number; window: number }; key?: string } = {},
): Handler<P> {
  return async (req, ctx) => {
    try {
      const ip = await clientIp();
      const l = opts.limit ?? LIMITS.api;
      const rl = await rateLimit(`${opts.key ?? "api"}:${ip}`, l.limit, l.window);
      if (!rl.ok) throw E.tooMany(rl.resetIn);
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Parse + validate a JSON body. Throws 400 on invalid JSON, 422 (VALIDATION) on schema errors. */
export async function body<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let data: unknown;
  try {
    const text = await req.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    throw E.bad("Invalid JSON body");
  }
  return schema.parse(data);
}

/** Parse + validate the query string (repeated keys become arrays). */
export function query<S extends ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const url = new URL(req.url);
  const obj: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const cur = obj[k];
    obj[k] = cur === undefined ? v : ([] as string[]).concat(cur, v);
  }
  return schema.parse(obj);
}

/** Per-actor mutation throttle. */
export async function throttle(key: string, preset: { limit: number; window: number } = LIMITS.write) {
  const rl = await rateLimit(key, preset.limit, preset.window);
  if (!rl.ok) throw E.tooMany(rl.resetIn);
}

// ───────────────────────────── Auth helpers ─────────────────────────────

/** Who is calling: a cookie session or an API token (`Authorization: Bearer ld_…`). */
export type Actor = {
  kind: "session" | "token";
  user: SessionUser;
  sessionId: string | null;
  /** present when kind === "token" */
  token: { id: string; teamId: string | null; scopes: string[] } | null;
};

export async function requireSession(): Promise<{ sessionId: string; user: SessionUser }> {
  const s = await getSession();
  if (!s) throw E.unauthorized();
  return s;
}

/**
 * Accepts `Authorization: Bearer ld_…` API tokens or the session cookie.
 * `scope` (e.g. "deployments:write") is checked for tokens only; sessions have every scope.
 */
export async function requireApiTokenOrSession(opts: { scope?: string } = {}): Promise<Actor> {
  const h = await headers();
  const auth = h.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const plain = auth.slice(7).trim();
    const row = await verifyApiToken(plain, await clientIp());
    if (!row) throw E.unauthorized("Invalid or expired API token");
    if (!tokenHasScope(row.scopes, opts.scope)) throw E.forbidden(`This token is missing the "${opts.scope}" scope`);
    const { disabledAt: _d, ...user } = row.user;
    return { kind: "token", user, sessionId: null, token: { id: row.id, teamId: row.teamId, scopes: row.scopes } };
  }
  const s = await requireSession();
  return { kind: "session", user: s.user, sessionId: s.sessionId, token: null };
}

export type TeamAccess = { actor: Actor; user: SessionUser; team: Team; role: TeamRole };

/**
 * Resolves a team by id or slug and checks the caller's membership role (VIEWER < MEMBER < ADMIN < OWNER).
 * Works with sessions and API tokens (team-restricted tokens only reach their team).
 * Unknown team and non-member both return 404 (no existence leak).
 */
export async function requireTeamRole(teamIdOrSlug: string, min: TeamRole = "VIEWER", opts: { scope?: string; actor?: Actor } = {}): Promise<TeamAccess> {
  const actor = opts.actor ?? (await requireApiTokenOrSession({ scope: opts.scope }));
  const team = await db.team.findFirst({ where: { OR: [{ id: teamIdOrSlug }, { slug: teamIdOrSlug }] } });
  if (!team) throw E.notFound("Team not found");
  if (actor.token?.teamId && actor.token.teamId !== team.id) throw E.notFound("Team not found");
  const m = await db.membership.findUnique({ where: { teamId_userId: { teamId: team.id, userId: actor.user.id } } });
  if (!m) throw E.notFound("Team not found");
  if (!hasRole(m.role, min)) throw E.forbidden(`This action requires the ${min.toLowerCase()} role`);
  return { actor, user: actor.user, team, role: m.role };
}

export type ProjectAccess = TeamAccess & { project: Project };

/** Project by id (`requireProjectRole(projectId)`) or by team + slug (`requireProjectRole(slug, min, { team })`). */
export async function requireProjectRole(
  projectIdOrSlug: string,
  min: TeamRole = "VIEWER",
  opts: { team?: string; scope?: string; actor?: Actor } = {},
): Promise<ProjectAccess> {
  const actor = opts.actor ?? (await requireApiTokenOrSession({ scope: opts.scope }));
  let project: Project | null;
  if (opts.team) {
    const team = await db.team.findFirst({ where: { OR: [{ id: opts.team }, { slug: opts.team }] }, select: { id: true } });
    project = team
      ? await db.project.findFirst({ where: { teamId: team.id, OR: [{ id: projectIdOrSlug }, { slug: projectIdOrSlug }] } })
      : null;
  } else {
    project = await db.project.findUnique({ where: { id: projectIdOrSlug } });
  }
  if (!project) throw E.notFound("Project not found");
  const access = await requireTeamRole(project.teamId, min, { actor });
  return { ...access, project };
}

/** Platform owner only (platform settings, servers). */
export async function requirePlatformOwner(): Promise<Actor> {
  const actor = await requireApiTokenOrSession();
  if (!actor.user.isPlatformOwner) throw E.forbidden("Only the platform owner can do this");
  return actor;
}
