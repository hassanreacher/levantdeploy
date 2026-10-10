import { z } from "zod";
import { route, json, body, requireSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { generateRecoveryCodes, verifyTotp } from "@/lib/auth/totp";
import { decryptString, sha256 } from "@/lib/crypto";
import { refreshUserSessions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

const schema = z.object({ code: z.string().trim().min(6).max(8) });

/** Step 2: confirm a code → 2FA on; returns recovery codes once. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const { code } = await body(req, schema);
  const user = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  const secret = decryptString(user.totpSecret);
  if (!secret) throw E.bad("Start the setup first");
  if (!verifyTotp(secret, code)) throw E.validation({ code: "Invalid code" }, "Invalid authentication code");
  const codes = generateRecoveryCodes();
  await db.user.update({ where: { id: user.id }, data: { totpEnabled: true, recoveryCodes: codes.map((c) => sha256(c)) } });
  await refreshUserSessions(user.id);
  await audit({ action: "user.2fa_enable", userId: user.id });
  return json({ ok: true, recoveryCodes: codes });
});
