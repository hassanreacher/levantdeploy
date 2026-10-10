import { route, json, requireSession } from "@/lib/http";
import { db } from "@/lib/db";

export const GET = route(async () => {
  const s = await requireSession();
  const sessions = await db.session.findMany({
    where: { userId: s.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return json({ sessions: sessions.map((x) => ({ ...x, current: x.id === s.sessionId })) });
});
