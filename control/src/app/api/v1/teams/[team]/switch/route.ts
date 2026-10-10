import { cookies } from "next/headers";
import { route, json, requireTeamRole } from "@/lib/http";
import { TEAM_COOKIE } from "@/lib/auth/jwt";

/** Remember the current team (used by "/" to pick where to land). */
export const POST = route<{ team: string }>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team } = await requireTeamRole(t, "VIEWER");
  (await cookies()).set(TEAM_COOKIE, team.slug, { path: "/", sameSite: "lax", maxAge: 365 * 86400 });
  return json({ ok: true, redirect: `/${team.slug}` });
});
