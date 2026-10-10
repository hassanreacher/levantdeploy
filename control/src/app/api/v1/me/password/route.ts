import { z } from "zod";
import { route, json, body, requireSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

const schema = z.object({ currentPassword: z.string().min(1), password: passwordSchema });

/** Change password; signs out every other session. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const input = await body(req, schema);
  const user = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) throw E.validation({ currentPassword: "Incorrect password" });
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.password) } });
  await revokeAllSessions(user.id, s.sessionId);
  await audit({ action: "user.password_change", userId: user.id });
  return json({ ok: true });
});
