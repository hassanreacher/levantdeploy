import { z } from "zod";
import { route, json, body, throttle } from "@/lib/http";
import { audit } from "@/lib/audit";
import { requireBuilderProject } from "@/lib/builder/agents/http-access";
import { listRuns, startRun } from "@/lib/builder/agents/runs";

export const dynamic = "force-dynamic";

const MAX_IMAGE = 5 * 1024 * 1024;
const attachment = z.object({
  url: z
    .string()
    .max(Math.ceil(MAX_IMAGE * 1.4))
    .refine((u) => /^https:\/\//.test(u) || /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u), "must be an https URL or a base64 image data URI"),
  name: z.string().max(200).optional(),
  type: z.string().max(100).optional(),
});

const schema = z.object({
  message: z.string().trim().min(1, "Say what you want to build or change").max(20_000),
  mode: z.enum(["build", "chat", "fix"]).default("build"),
  attachments: z.array(attachment).max(4).optional(),
});

/** GET /api/v1/builder/projects/:id/runs — recent runs (VIEWER). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireBuilderProject(id, "VIEWER", "projects:read");
  return json({ items: await listRuns(id) });
});

/**
 * POST /api/v1/builder/projects/:id/runs — { message, mode?: "build"|"chat"|"fix", attachments?: [{url}] } (MEMBER).
 * Counts one builder credit (402 PLAN_LIMIT when exhausted), 409 when a run is already active.
 * → 201 { run, messageId, credits }. Follow progress via GET …/runs/:runId/events (SSE).
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const { project, actor, team } = await requireBuilderProject(id, "MEMBER", "projects:write");
  await throttle(`builder:run:${actor.user.id}`, { limit: 20, window: 60 });
  const res = await startRun({ builderProjectId: project.id, userId: actor.user.id, message: input.message, mode: input.mode, attachments: input.attachments });
  await audit({ action: "builder.run", teamId: team.id, actor, targetType: "builder_project", targetId: project.id, meta: { runId: res.run.id, mode: input.mode } });
  return json(res, 201);
});
