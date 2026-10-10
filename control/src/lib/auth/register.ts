import type { TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { createTeam, uniqueTeamSlug } from "@/lib/teams";
import { sha256 } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { E } from "@/lib/http";
import { hashPassword } from "./password";
import { assertCanAddMember } from "@/lib/plans/enforce";

/** Whether a new account may be created (first user always may; later: open registration or a valid invite). */
export async function registrationAllowed(inviteToken?: string | null) {
  const users = await db.user.count();
  if (users === 0) return { allowed: true, firstUser: true };
  const configured = await getSetting("platform.registration");
  // plans area: "closed" = no new accounts at all (even with an invite) unless REGISTRATION=open forces it
  if (configured === "closed" && process.env.REGISTRATION !== "open") return { allowed: false, firstUser: false, closed: true };
  if (inviteToken) {
    const inv = await findValidInvite(inviteToken);
    if (inv) return { allowed: true, firstUser: false };
  }
  const mode = process.env.REGISTRATION === "open" ? "open" : configured;
  return { allowed: mode === "open", firstUser: false };
}

export async function findValidInvite(token: string) {
  const inv = await db.invite.findUnique({ where: { tokenHash: sha256(token) }, include: { team: true } });
  if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt < new Date()) return null;
  return inv;
}

/** Creates the user + their personal team ("Personal"). The first user becomes platform owner. */
export async function createUserWithPersonalTeam(input: { email: string; name: string; password: string; firstUser?: boolean; verified?: boolean }) {
  const exists = await db.user.findUnique({ where: { email: input.email } });
  if (exists) throw E.conflict("An account with this email already exists");
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      // plans area: the first (owner) account is verified; everyone else verifies through the emailed link
      data: { email: input.email, name: input.name, passwordHash, isPlatformOwner: !!input.firstUser, emailVerifiedAt: input.firstUser || input.verified ? new Date() : null },
    });
    // personal team "Personal", slug derived from the email local part
    const slug = await uniqueTeamSlug(input.email.split("@")[0] || input.name, tx);
    const team = await createTeam({ name: "Personal", slug, ownerId: user.id, isPersonal: true }, tx);
    return { user, team };
  });
}

/** Accept an invite for a user (idempotent if already a member: keeps the higher role). */
export async function acceptInvite(token: string, user: { id: string; email: string }) {
  const inv = await findValidInvite(token);
  if (!inv) throw E.notFound("This invite is invalid or has expired");
  if (inv.email && inv.email.toLowerCase() !== user.email.toLowerCase()) throw E.forbidden(`This invite was sent to ${inv.email}`);
  // plans area: the invite is already counted as a pending member → only blocks when the plan was lowered meanwhile
  const already = await db.membership.findUnique({ where: { teamId_userId: { teamId: inv.teamId, userId: user.id } }, select: { id: true } });
  if (!already) await assertCanAddMember(inv.teamId, { pendingIncluded: true });
  await db.$transaction(async (tx) => {
    const existing = await tx.membership.findUnique({ where: { teamId_userId: { teamId: inv.teamId, userId: user.id } } });
    if (!existing) await tx.membership.create({ data: { teamId: inv.teamId, userId: user.id, role: inv.role as TeamRole } });
    await tx.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), acceptedById: user.id } });
  });
  return inv.team;
}
