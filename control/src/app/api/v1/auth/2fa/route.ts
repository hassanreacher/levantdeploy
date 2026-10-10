import { z } from "zod";
import { cookies } from "next/headers";
import { route, body, json, E } from "@/lib/http";
import { db } from "@/lib/db";
import { TWO_FA_COOKIE, verifyTwoFactorJwt } from "@/lib/auth/jwt";
import { verifyTotp } from "@/lib/auth/totp";
import { decryptString, sha256 } from "@/lib/crypto";
import { createSession } from "@/lib/auth/session";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { safeNext } from "@/lib/auth/redirect";

const schema = z.object({ code: z.string().trim().min(6).max(20), next: z.string().optional() });

/** Second login step: TOTP code or a recovery code (xxxxx-xxxxx). */
export const POST = route(async (req) => {
  const input = await body(req, schema);
  const tok = (await cookies()).get(TWO_FA_COOKIE)?.value;
  const p = tok ? await verifyTwoFactorJwt(tok) : null;
  if (!p) throw E.unauthorized("Your sign-in expired. Please sign in again.");
  const rl = await rateLimit(`2fa:${p.uid}`, LIMITS.totp.limit, LIMITS.totp.window);
  if (!rl.ok) throw E.tooMany(rl.resetIn);
  const user = await db.user.findUnique({ where: { id: p.uid } });
  if (!user || !user.totpEnabled || user.disabledAt) throw E.unauthorized();
  const secret = decryptString(user.totpSecret);
  let ok = !!secret && verifyTotp(secret, input.code);
  if (!ok && input.code.includes("-")) {
    const h = sha256(input.code.toLowerCase());
    if (user.recoveryCodes.includes(h)) {
      ok = true;
      await db.user.update({ where: { id: user.id }, data: { recoveryCodes: user.recoveryCodes.filter((c) => c !== h) } });
      await audit({ action: "user.recovery_code_used", userId: user.id });
    }
  }
  if (!ok) throw E.validation({ code: "Invalid code" }, "Invalid authentication code");
  await createSession(user.id);
  await audit({ action: "user.login", userId: user.id, meta: { twoFactor: true } });
  return json({ redirect: safeNext(input.next) ?? "/" });
});
