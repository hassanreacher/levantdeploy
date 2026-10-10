import { z } from "zod";
import { route, json, body, requireSession } from "@/lib/http";
import { db } from "@/lib/db";

/** POST /api/v1/me/notifications/read { ids?: string[] }  — no ids = mark all read */
export const POST = route(async (req) => {
  const { user } = await requireSession();
  const { ids } = await body(req, z.object({ ids: z.array(z.string().max(64)).max(200).optional() }));
  const r = await db.userNotification.updateMany({ where: { userId: user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
  return json({ updated: r.count });
});
