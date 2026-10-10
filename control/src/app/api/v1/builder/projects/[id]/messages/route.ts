import { z } from "zod";
import { json, query } from "@/lib/http";
import { db } from "@/lib/db";
import { builderRoute, requireBuilder } from "@/lib/builder/access";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/builder/projects/:id/messages?limit=&before=<id> → { items: BuilderMessage[] (oldest first), next } (VIEWER)
 * Chat history of the builder editor (builder-ui). `next` = cursor for older messages.
 */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), before: z.string().max(64).optional() }));
  await requireBuilder(id, "VIEWER");
  const before = q.before ? await db.builderMessage.findFirst({ where: { id: q.before, builderProjectId: id }, select: { createdAt: true } }) : null;
  const rows = await db.builderMessage.findMany({
    where: { builderProjectId: id, ...(before ? { createdAt: { lt: before.createdAt } } : {}) },
    orderBy: { createdAt: "desc" },
    take: q.limit,
    include: { author: { select: { id: true, name: true } } },
  });
  const items = rows.reverse().map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    commitSha: m.commitSha,
    agentRunId: m.agentRunId,
    meta: m.meta ?? {},
    createdAt: m.createdAt.toISOString(),
    author: m.author,
  }));
  return json({ items, next: rows.length === q.limit ? items[0]?.id ?? null : null });
});
