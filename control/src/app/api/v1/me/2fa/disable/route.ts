import { z } from "zod";
import { route, json, body, requireSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { refreshUserSessions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

const schema = z.object({ password: z.string().min(1) });

export const POST = route(async (req) => {
  const s = await requireSession();
  const { password } = await body(req, schema);
  const user = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  if (!(await verifyPassword(password, user.passwordHash))) throw E.validation({ password: "Incorrect password" });
  await db.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, recoveryCodes: [] } });
  await refreshUserSessions(user.id);
  await audit({ action: "user.2fa_disable", userId: user.id });
  return json({ ok: true });
});
