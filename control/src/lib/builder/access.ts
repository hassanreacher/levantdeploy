/**
 * builder-core API helpers (Next-only: imports @/lib/http — never import from worker code).
 *   requireBuilder(id, min, scope)   team role check for a builder project (non-members get 404)
 *   builderRoute(fn, opts)           route() + maps builder library errors to API errors
 */
import type { TeamRole } from "@prisma/client";
import { ApiError, E, requireTeamRole, route, type Actor } from "@/lib/http";
import { db } from "@/lib/db";
import { FileError } from "./files";
import { GitError } from "./git";
import { VisualEditError } from "./visual-edit";
import { PublishError } from "./publish";
import { ExportError } from "./export";
import { BackendError } from "./backend";
import { BuilderProjectError } from "./projects";
import { BaseError } from "@/lib/base/service";

export async function requireBuilder(id: string, min: TeamRole = "VIEWER", scope: "projects:read" | "projects:write" = min === "VIEWER" ? "projects:read" : "projects:write") {
  if (!/^[a-z0-9]{8,40}$/.test(id)) throw E.notFound("App not found");
  const builder = await db.builderProject.findUnique({ where: { id } });
  if (!builder) throw E.notFound("App not found");
  const access = await requireTeamRole(builder.teamId, min, { scope });
  return { builder, actor: access.actor as Actor, team: access.team, role: access.role, user: access.actor.user };
}

const CODES: Record<number, string> = { 400: "BAD_REQUEST", 404: "NOT_FOUND", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 422: "UNPROCESSABLE", 502: "UPSTREAM_ERROR" };

export function toApiError(e: unknown): unknown {
  if (e instanceof ApiError) return e;
  if (e instanceof FileError || e instanceof VisualEditError || e instanceof PublishError || e instanceof ExportError || e instanceof BackendError || e instanceof BuilderProjectError) {
    return new ApiError(e.status, CODES[e.status] ?? "BAD_REQUEST", e.message);
  }
  if (e instanceof GitError) {
    if (/not found|Invalid commit|Invalid path/.test(e.message)) return new ApiError(404, "NOT_FOUND", e.message.replace(/^git \w+ failed: /, ""));
    if (/Another change/.test(e.message)) return new ApiError(409, "CONFLICT", e.message);
  }
  if (e instanceof BaseError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : e.code === "LIMIT" ? 402 : 400;
    return new ApiError(status, e.code, e.message);
  }
  return e; // PlanLimitError etc. are handled by route(); everything else → 500
}

type Handler<P extends Record<string, string>> = Parameters<typeof route<P>>[0];

export function builderRoute<P extends Record<string, string> = Record<string, string>>(fn: Handler<P>, opts: Parameters<typeof route>[1] = {}) {
  return route<P>(async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      throw toApiError(e);
    }
  }, opts);
}
