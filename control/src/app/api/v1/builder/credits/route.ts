import { z } from "zod";
import { route, json, query, requireTeamRole } from "@/lib/http";
import { builderCredits } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/builder/credits?team=<id|slug> — AI builder credits of the team (VIEWER):
 * { credits: { plan, usedToday, usedMonth, bonusUsedMonth, limits: { messagesPerDay, messagesPerMonth, dailyBonus, projects, previewHoursMonth },
 *   remainingToday, remainingMonth, allowed, reason, resetsAt: { day, month } } }  (null = unlimited)
 */
export const GET = route(async (req) => {
  const q = query(req, z.object({ team: z.string().min(1).max(100) }));
  const { team } = await requireTeamRole(q.team, "VIEWER", { scope: "projects:read" });
  return json({ credits: await builderCredits(team.id) });
});
