import { z } from "zod";
import { route, json, body, clientIp, E } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { verifyEmailToken } from "@/lib/plans/signup";

/** POST /api/v1/auth/verify-email { token } → { ok: true, email } (plans area). Works signed in or out. */
export const POST = route(async (req) => {
  const ip = await clientIp();
  const rl = await rateLimit(`verify-email:${ip}`, 30, 900);
  if (!rl.ok) throw E.tooMany(rl.resetIn);
  const { token } = await body(req, z.object({ token: z.string().min(10).max(200) }));
  const r = await verifyEmailToken(token);
  await audit({ action: "user.email_verified", userId: r.userId, meta: { email: r.email } });
  return json({ ok: true, email: r.email });
});
