import { z } from "zod";
import { route, json, query, requireTeamRole } from "@/lib/http";
import { db } from "@/lib/db";

const q = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(80).optional(),
  userId: z.string().optional(),
});

/** Paginated audit log (newest first). `next` is the cursor for the following page. */
export const GET = route<{ team: string }>(async (req, { params }) => {
  const { team: t } = await params;
  const { team } = await requireTeamRole(t, "ADMIN");
  const { cursor, limit, action, userId } = query(req, q);
  const rows = await db.auditLog.findMany({
    where: { teamId: team.id, ...(action ? { action: { startsWith: action } } : {}), ...(userId ? { userId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, name: true, email: true, avatar: true } }, apiToken: { select: { id: true, name: true } } },
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return json({ items, next: hasMore ? items[items.length - 1]!.id : null });
});
