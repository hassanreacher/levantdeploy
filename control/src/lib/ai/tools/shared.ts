import { z } from "zod/v4";
import type { Deployment, TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { aiProjectAccess, ToolError, type AiActor, type AiProjectAccess } from "../permissions";

/** Context every tool runs with: who asked, which team (and optionally project) the conversation is scoped to. */
export type ToolCtx = {
  actor: AiActor;
  teamId: string;
  projectId: string | null;
  conversationId: string;
};

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  /** what + WHEN to call it (the model relies on this) */
  description: string;
  schema: S;
  /** minimum team role; may depend on the input (e.g. reveal env values → ADMIN) */
  minRole: TeamRole | ((input: z.infer<S>) => TeamRole);
  /** API-token scope (checked only for token-driven conversations) */
  scope?: string | ((input: z.infer<S>) => string);
  /** mutating → the agent only proposes it; it runs after the user approves */
  approval: boolean | ((input: z.infer<S>) => boolean);
  /** destructive → approval needs the user to type this text (e.g. the project slug) */
  confirmText?: (input: z.infer<S>, ctx: ToolCtx) => Promise<string | null>;
  /** one-line description for the tool card / approval card */
  summarize: (input: z.infer<S>) => string;
  /** display-safe copy of the input stored on AgentAction.input (mask secrets) */
  display?: (input: z.infer<S>) => Record<string, unknown>;
  /** checks done when the action is proposed (access, target exists) — throws ToolError */
  precheck?: (input: z.infer<S>, ctx: ToolCtx) => Promise<void>;
  run: (input: z.infer<S>, ctx: ToolCtx) => Promise<unknown>;
};

export const defineTool = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t;

export const projectArg = z
  .string()
  .min(1)
  .max(120)
  .optional()
  .describe("Project slug or id. Omit to use the project this conversation is about.");

export const deploymentArg = z
  .string()
  .min(1)
  .max(60)
  .optional()
  .describe('Deployment id, short id, number ("#12" or "12"), "latest" or "production". Omit for the latest deployment.');

export async function resolveProject(ctx: ToolCtx, ref: string | undefined, min: TeamRole, scope?: string): Promise<AiProjectAccess> {
  const r = ref ?? ctx.projectId;
  if (!r) throw new ToolError("INVALID", "Which project? Pass `project` (slug). Use list_projects to see the team's projects.");
  return aiProjectAccess(ctx.actor, ctx.teamId, r, min, scope);
}

/** Resolve a deployment reference inside a project the actor can access. */
export async function resolveDeployment(
  ctx: ToolCtx,
  ref: string | undefined,
  projectRef: string | undefined,
  min: TeamRole,
  scope?: string,
): Promise<AiProjectAccess & { deployment: Deployment }> {
  // A full id or short id identifies the project by itself.
  if (ref && !/^#?\d+$/.test(ref) && ref !== "latest" && ref !== "production") {
    const d = await db.deployment.findFirst({ where: { OR: [{ id: ref }, { shortId: ref }], project: { teamId: ctx.teamId } } });
    if (!d) throw new ToolError("NOT_FOUND", `Deployment "${ref}" not found`);
    const access = await aiProjectAccess(ctx.actor, ctx.teamId, d.projectId, min, scope);
    return { ...access, deployment: d };
  }
  const access = await resolveProject(ctx, projectRef, min, scope);
  let d: Deployment | null;
  if (ref && /^#?\d+$/.test(ref)) d = await db.deployment.findUnique({ where: { projectId_number: { projectId: access.project.id, number: Number(ref.replace("#", "")) } } });
  else if (ref === "production") d = await db.deployment.findFirst({ where: { projectId: access.project.id, isCurrentProduction: true } });
  else d = await db.deployment.findFirst({ where: { projectId: access.project.id }, orderBy: { number: "desc" } });
  if (!d) throw new ToolError("NOT_FOUND", ref ? `Deployment ${ref} not found in ${access.project.slug}` : `${access.project.slug} has no deployments yet`);
  return { ...access, deployment: d };
}

export function deploymentBrief(d: Deployment) {
  return {
    id: d.id,
    number: d.number,
    shortId: d.shortId,
    status: d.status,
    target: d.target,
    trigger: d.trigger,
    url: d.url,
    isCurrentProduction: d.isCurrentProduction,
    branch: d.branch,
    commitSha: d.commitSha?.slice(0, 12) ?? null,
    commitMessage: d.commitMessage?.split("\n")[0]?.slice(0, 160) ?? null,
    errorStep: d.errorStep,
    errorMessage: d.errorMessage?.slice(0, 500) ?? null,
    createdAt: d.createdAt.toISOString(),
    readyAt: d.readyAt?.toISOString() ?? null,
    durationMs: d.duration,
  };
}

/** Same rules as the dashboard env API. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_ENV = new Set(["LEVANT", "LEVANT_ENV", "LEVANT_URL", "LEVANT_DEPLOYMENT_ID", "LEVANT_GIT_COMMIT_SHA", "LEVANT_GIT_BRANCH", "PORT"]);
export const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export const mask = (v: string) => (v.length <= 4 ? "••••" : `••••${v.slice(-4)}`);
