import { cookies } from "next/headers";
import { route, json, requireSession, E } from "@/lib/http";
import { findValidInvite, acceptInvite } from "@/lib/auth/register";
import { TEAM_COOKIE } from "@/lib/auth/jwt";
import { audit } from "@/lib/audit";

type P = { token: string };

/** Public preview of an invite. */
export const GET = route<P>(async (_req, { params }) => {
  const { token } = await params;
  const inv = await findValidInvite(token);
  if (!inv) throw E.notFound("This invite is invalid or has expired");
  return json({ team: { name: inv.team.name, slug: inv.team.slug }, role: inv.role, email: inv.email, expiresAt: inv.expiresAt });
});

export const POST = route<P>(async (_req, { params }) => {
  const { token } = await params;
  const s = await requireSession();
  const team = await acceptInvite(token, s.user);
  (await cookies()).set(TEAM_COOKIE, team.slug, { path: "/", sameSite: "lax", maxAge: 365 * 86400 });
  await audit({ action: "invite.accept", teamId: team.id, userId: s.user.id, targetType: "team", targetId: team.id });
  return json({ ok: true, redirect: `/${team.slug}` });
});
