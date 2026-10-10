import { z } from "zod";
import { route, body, json, E } from "@/lib/http";
import { db } from "@/lib/db";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { sha256 } from "@/lib/crypto";
import { revokeAllSessions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

const schema = z.object({ token: z.string().min(10).max(200), password: passwordSchema });

export const POST = route(async (req) => {
  const { token, password } = await body(req, schema);
  const pr = await db.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!pr || pr.usedAt || pr.expiresAt < new Date()) throw E.bad("This reset link is invalid or has expired");
  await db.$transaction([
    db.user.update({ where: { id: pr.userId }, data: { passwordHash: await hashPassword(password) } }),
    db.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } }),
    db.passwordReset.updateMany({ where: { userId: pr.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  await revokeAllSessions(pr.userId);
  await audit({ action: "user.password_reset", userId: pr.userId });
  return json({ ok: true, redirect: "/login?reset=1" });
});
