import { z } from "zod";
import { cookies } from "next/headers";
import { route, body, json, E, clientIp } from "@/lib/http";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { TWO_FA_COOKIE, signJwt } from "@/lib/auth/jwt";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { safeNext } from "@/lib/auth/redirect";

const schema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Enter your email"),
  password: z.string().min(1, "Enter your password"),
  next: z.string().optional(),
});

// constant-time-ish: compare against a dummy hash when the user doesn't exist
const DUMMY = "$2b$12$zTjFssuEG8DAuzy6Yxfhk.2yMWZdSSKycGxQTb53xXLops35jwBFy";

export const POST = route(async (req) => {
  const input = await body(req, schema);
  const ip = await clientIp();
  const rl = await rateLimit(`login:${ip}:${input.email}`, LIMITS.login.limit, LIMITS.login.window);
  if (!rl.ok) throw E.tooMany(rl.resetIn);

  const user = await db.user.findUnique({ where: { email: input.email } });
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY);
  if (!user || !ok || user.disabledAt) {
    if (user) await audit({ action: "user.login_failed", userId: user.id, meta: { reason: user.disabledAt ? "disabled" : "password" } });
    throw E.unauthorized("Incorrect email or password");
  }
  const next = safeNext(input.next);
  if (user.totpEnabled) {
    const t = await signJwt({ uid: user.id, purpose: "2fa" }, "10m");
    (await cookies()).set(TWO_FA_COOKIE, t, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: process.env.PLATFORM_SCHEME === "https" });
    return json({ twoFactor: true, redirect: `/2fa${next ? `?next=${encodeURIComponent(next)}` : ""}` });
  }
  await createSession(user.id);
  await audit({ action: "user.login", userId: user.id });
  return json({ twoFactor: false, redirect: next ?? "/" });
});
