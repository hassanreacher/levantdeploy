import { z } from "zod";
import { route, json, body } from "@/lib/http";
import { db } from "@/lib/db";
import { pollDeviceLogin } from "@/lib/git/cli-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/cli/login/poll { deviceCode }
 *   202 { status: "pending" } · 200 { status: "approved", token, user, team } · 403 { status: "denied" } · 410 { status: "expired" }
 */
export const POST = route(
  async (req) => {
    const { deviceCode } = await body(req, z.object({ deviceCode: z.string().min(20).max(100) }));
    const r = await pollDeviceLogin(deviceCode);
    if (r.status !== "approved") return json({ status: r.status }, r.status === "pending" ? 202 : r.status === "denied" ? 403 : 410);
    const user = await db.user.findUnique({ where: { id: r.userId }, select: { id: true, email: true, name: true } });
    return json({ status: "approved", token: r.token, user, team: r.teamSlug });
  },
  { limit: { limit: 120, window: 60 }, key: "cli-poll" },
);
