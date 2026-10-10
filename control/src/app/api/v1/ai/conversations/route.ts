import { z } from "zod";
import { route, json, body, query, requireTeamRole, requireProjectRole, throttle } from "@/lib/http";
import { db } from "@/lib/db";
import type { UiConversation } from "@/lib/ai/types";

/**
 * GET  /api/v1/ai/conversations?team=<slug|id>[&project=<slug|id>][&scope=project|team|all]  → { items }
 * POST /api/v1/ai/conversations { team, project? }                                           → { conversation }
 * Conversations are private to the user who started them.
 */
const listQ = z.object({ team: z.string().min(1), project: z.string().optional(), scope: z.enum(["project", "team", "all"]).optional() });

export const GET = route(async (req) => {
  const q = query(req, listQ);
  const { team, user } = await requireTeamRole(q.team, "VIEWER");
  let projectId: string | null | undefined;
  if (q.project) projectId = (await requireProjectRole(q.project, "VIEWER", { team: team.id })).project.id;
  const scope = q.scope ?? (q.project ? "project" : "all");
  const rows = await db.agentConversation.findMany({
    where: { teamId: team.id, userId: user.id, ...(scope === "project" ? { projectId: projectId ?? undefined } : scope === "team" ? { projectId: null } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: { project: { select: { slug: true } } },
  });
  const items: UiConversation[] = rows.map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, projectSlug: c.project?.slug ?? null, teamSlug: team.slug, model: c.model, updatedAt: c.updatedAt.toISOString() }));
  return json({ items });
});

const createSchema = z.object({ team: z.string().min(1), project: z.string().nullable().optional(), title: z.string().max(120).optional() });

export const POST = route(async (req) => {
  const input = await body(req, createSchema);
  const { team, user } = await requireTeamRole(input.team, "VIEWER");
  await throttle(`ai:conv:${user.id}`);
  const project = input.project ? (await requireProjectRole(input.project, "VIEWER", { team: team.id })).project : null;
  const c = await db.agentConversation.create({ data: { teamId: team.id, projectId: project?.id ?? null, userId: user.id, title: input.title || "New conversation" } });
  const conversation: UiConversation = { id: c.id, title: c.title, projectId: c.projectId, projectSlug: project?.slug ?? null, teamSlug: team.slug, model: null, updatedAt: c.updatedAt.toISOString() };
  return json({ conversation }, 201);
});
