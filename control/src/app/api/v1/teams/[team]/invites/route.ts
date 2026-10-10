import { z } from "zod";
import { route, json, body, requireTeamRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { appUrl } from "@/lib/env";
import { sendMail } from "@/lib/email";
import { audit } from "@/lib/audit";
import { assertCanAddMember } from "@/lib/plans/enforce";

type P = { team: string };

export const GET = route<P>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team } = await requireTeamRole(t, "ADMIN");
  const invites = await db.invite.findMany({
    where: { teamId: team.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true, invitedBy: { select: { name: true, email: true } } },
  });
  return json({ invites });
});

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(254).optional().nullable().or(z.literal("").transform(() => null)),
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

/** Creates an invite link. The URL (with the plain token) is returned only once. */
export const POST = route<P>(async (req, { params }) => {
  const { team: t } = await params;
  const input = await body(req, schema);
  const { team, role, actor } = await requireTeamRole(t, "ADMIN");
  if (input.role === "OWNER" && role !== "OWNER") throw E.forbidden("Only owners can invite owners");
  await throttle(`invite:${actor.user.id}`, { limit: 30, window: 3600 });
  await assertCanAddMember(team.id); // plans area: members + pending invites (402 PLAN_LIMIT)
  const token = randomToken(24);
  const invite = await db.invite.create({
    data: {
      teamId: team.id,
      email: input.email ?? null,
      role: input.role,
      tokenHash: sha256(token),
      invitedById: actor.user.id,
      expiresAt: new Date(Date.now() + input.expiresInDays * 86400_000),
    },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  const url = appUrl(`/invite/${token}`);
  if (input.email) {
    await sendMail({
      to: input.email,
      subject: `${actor.user.name} invited you to ${team.name} on LevantDeploy`,
      text: `${actor.user.name} invited you to join the team "${team.name}" as ${input.role.toLowerCase()}.\n\nAccept: ${url}\n\nThis link expires in ${input.expiresInDays} days.`,
    }).catch(() => {});
  }
  await audit({ action: "invite.create", teamId: team.id, actor, targetType: "invite", targetId: invite.id, meta: { email: input.email ?? null, role: input.role } });
  return json({ invite, url }, 201);
});
