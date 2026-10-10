import { z } from "zod";
import { route, body, json, E, clientIp } from "@/lib/http";
import { db } from "@/lib/db";
import { emailSchema } from "@/lib/auth/password";
import { randomToken, sha256 } from "@/lib/crypto";
import { sendMail } from "@/lib/email";
import { appUrl } from "@/lib/env";
import { rateLimit, LIMITS } from "@/lib/rate-limit";

const schema = z.object({ email: emailSchema });

/** Always 200 (no account enumeration). In dev without SMTP the link is logged to the server console. */
export const POST = route(async (req) => {
  const { email } = await body(req, schema);
  const ip = await clientIp();
  const rl = await rateLimit(`reset:${ip}:${email}`, LIMITS.reset.limit, LIMITS.reset.window);
  if (!rl.ok) throw E.tooMany(rl.resetIn);
  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.disabledAt) {
    const token = randomToken(32);
    await db.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000), ip } });
    const link = appUrl(`/reset-password?token=${token}`);
    await sendMail({
      to: user.email,
      subject: "Reset your LevantDeploy password",
      text: `Hi ${user.name},\n\nReset your password using this link (valid for 1 hour):\n${link}\n\nIf you didn't request this, ignore this email.`,
    });
  }
  return json({ ok: true });
});
