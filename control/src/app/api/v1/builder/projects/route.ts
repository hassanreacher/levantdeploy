import { z } from "zod";
import { route, json, body, query, requireTeamRole, throttle } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { toApiError } from "@/lib/builder/access";
import { builderProjectDTO, createBuilderProject, DTO_INCLUDE, startInitialRun } from "@/lib/builder/projects";

export const dynamic = "force-dynamic";

/** GET /api/v1/builder/projects?team= → { items: BuilderProject[] } (VIEWER) */
export const GET = route(async (req) => {
  const q = query(req, z.object({ team: z.string().min(1).max(64), limit: z.coerce.number().int().min(1).max(200).default(100) }));
  const { team } = await requireTeamRole(q.team, "VIEWER", { scope: "projects:read" });
  const rows = await db.builderProject.findMany({ where: { teamId: team.id }, orderBy: { updatedAt: "desc" }, take: q.limit, include: DTO_INCLUDE });
  return json({ items: rows.map(builderProjectDTO) });
});

const attachment = z.object({ url: z.string().max(8_000_000), name: z.string().max(200).optional(), type: z.string().max(100).optional(), kind: z.string().max(20).optional() });
const schema = z.object({
  team: z.string().min(1).max(64),
  name: z.string().trim().max(80).optional(),
  prompt: z.string().trim().max(20_000).optional(),
  description: z.string().trim().max(500).optional(),
  template: z.string().max(40).optional(),
  /** gallery starter id (blank, saas-landing, …) — informational */
  starter: z.string().max(40).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  settings: z.record(z.unknown()).optional(),
  attachments: z.array(attachment).max(5).optional(),
  /** false = create only (don't start the agents even when a prompt is given) */
  run: z.boolean().default(true),
});

/**
 * POST /api/v1/builder/projects { team, prompt?, name?, template?, attachments? } → 201 { project, run, runError }
 * Creates the app (workspace from the template + initial commit). With a prompt, the agents start a "build" run
 * right away (builder-agents); if that fails (credits, no AI provider) the app still exists and runError says why.
 */
export const POST = route(
  async (req) => {
    const input = await body(req, schema);
    const { team, actor } = await requireTeamRole(input.team, "MEMBER", { scope: "projects:write" });
    await throttle(`builder-create:${actor.user.id}`, { limit: 20, window: 3600 });
    let project;
    try {
      project = await createBuilderProject({
        teamId: team.id,
        userId: actor.user.id,
        name: input.name,
        prompt: input.prompt,
        description: input.description,
        template: input.template === "blank" ? undefined : input.template,
        settings: { ...(input.settings ?? {}), ...(input.visibility ? { visibility: input.visibility } : {}), ...(input.starter ? { starter: input.starter } : {}) },
      });
    } catch (e) {
      throw toApiError(e);
    }
    await audit({ action: "builder.create", teamId: team.id, actor, targetType: "builder_project", targetId: project.id, meta: { name: project.name, template: project.template } });
    let run: { id: string } | null = null;
    let runError: string | null = null;
    if (input.prompt && input.run) {
      const r = await startInitialRun(project.id, { userId: actor.user.id, prompt: input.prompt, attachments: input.attachments?.map((a) => ({ url: a.url, name: a.name, type: a.type })) });
      run = r.runId ? { id: r.runId } : null;
      runError = r.error;
    }
    const row = await db.builderProject.findUniqueOrThrow({ where: { id: project.id }, include: DTO_INCLUDE });
    return json({ project: builderProjectDTO(row), run, runError }, 201);
  },
  { key: "builder-create" },
);
