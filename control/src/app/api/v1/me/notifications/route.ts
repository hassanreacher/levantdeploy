import { z } from "zod";
import { route, json, query, requireSession } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/notifications?limit=&unread=1 → { items, unread } (in-app bell) */
export const GET = route(async (req) => {
  const { user } = await requireSession();
  const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), unread: z.enum(["0", "1"]).default("0") }));
  const [items, unread] = await Promise.all([
    db.userNotification.findMany({ where: { userId: user.id, ...(q.unread === "1" ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: q.limit }),
    db.userNotification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  return json({ items, unread });
});
