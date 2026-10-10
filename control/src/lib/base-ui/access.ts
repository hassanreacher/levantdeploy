import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import type { TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { E, requireTeamRole, type Actor, type TeamAccess } from "@/lib/http";
import { getProjectContext, getTeamContext, type TeamContext } from "@/lib/auth/context";
import { baseInclude, toBaseDTO, type BaseRow } from "./dto";
import { SettingsError } from "./settings";
import { isRef, type BaseProjectDTO } from "./shared";

/**
 * Permission model (BASE-SPEC): VIEWER sees, MEMBER uses Studio / functions / SQL, ADMIN+ secrets, settings, delete.
 * Token scopes: base:read / base:write.
 */
export type BaseAccess = TeamAccess & { base: BaseRow };

/** API: Base project by ref (team inferred). Unknown ref and non-members → 404. */
export async function requireBaseRole(ref: string, min: TeamRole = "VIEWER", opts: { scope?: string; actor?: Actor; allowDeleting?: boolean } = {}): Promise<BaseAccess> {
  if (!isRef(ref)) throw E.notFound("Base project not found");
  const base = await db.baseProject.findUnique({ where: { ref }, include: baseInclude });
  if (!base) throw E.notFound("Base project not found");
  const access = await requireTeamRole(base.teamId, min, { scope: opts.scope ?? (min === "VIEWER" ? "base:read" : "base:write"), actor: opts.actor });
  return { ...access, base };
}

/** Map lib errors to API errors. */
export function mapBaseError(e: unknown): never {
  if (e instanceof SettingsError) throw E.validation({ [e.field]: e.message });
  throw e;
}

export type BasePageContext = TeamContext & {
  base: BaseProjectDTO;
  row: BaseRow;
  /** URL prefix of the Base pages: `/{team}/base/{ref}` or `/{team}/{project}/backend` */
  basePath: string;
  /** set when rendered inside a Deploy project's Backend tab */
  project: { id: string; slug: string; name: string } | null;
};

/** Page: standalone Base project `/{team}/base/{ref}`. */
export const getBaseContext = cache(async (teamSlug: string, ref: string): Promise<BasePageContext> => {
  const ctx = await getTeamContext(teamSlug);
  if (!isRef(ref)) notFound();
  const row = await db.baseProject.findFirst({ where: { ref, teamId: ctx.team.id }, include: baseInclude });
  if (!row) notFound();
  return { ...ctx, row, base: toBaseDTO(row), basePath: `/${ctx.team.slug}/base/${row.ref}`, project: null };
});

/** Page: Deploy project's Backend tab `/{team}/{project}/backend` (null when no backend attached). */
export const getBackendContext = cache(async (teamSlug: string, projectSlug: string): Promise<BasePageContext | (TeamContext & { base: null; project: { id: string; slug: string; name: string } })> => {
  const ctx = await getProjectContext(teamSlug, projectSlug);
  const row = await db.baseProject.findFirst({ where: { projectId: ctx.project.id }, include: baseInclude });
  const project = { id: ctx.project.id, slug: ctx.project.slug, name: ctx.project.name };
  if (!row) return { ...ctx, base: null, project };
  return { ...ctx, row, base: toBaseDTO(row), basePath: `/${ctx.team.slug}/${ctx.project.slug}/backend`, project };
});

/** Helper for backend sub-pages: notFound() when the project has no backend. */
export async function requireBackendContext(teamSlug: string, projectSlug: string): Promise<BasePageContext> {
  const c = await getBackendContext(teamSlug, projectSlug);
  if (!c.base) notFound();
  return c as BasePageContext;
}

/** Where a Base project's pages live (owning project's Backend tab when attached). */
export const basePathFor = (teamSlug: string, b: { ref: string; project: { slug: string } | null }) =>
  b.project ? `/${teamSlug}/${b.project.slug}/backend` : `/${teamSlug}/base/${b.ref}`;

/** Standalone page; an attached backend lives in its project's Backend tab → redirect there (same sub-page). */
export async function standaloneContext(teamSlug: string, ref: string, sub = ""): Promise<BasePageContext> {
  const c = await getBaseContext(teamSlug, ref);
  if (c.base.project) redirect(`/${c.team.slug}/${c.base.project.slug}/backend${sub ? `/${sub}` : ""}`);
  return c;
}
