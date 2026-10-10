import { z } from "zod";
import { cookies } from "next/headers";
import { route, body, json, E, clientIp } from "@/lib/http";
import { emailSchema, passwordSchema } from "@/lib/auth/password";
import { registrationAllowed, createUserWithPersonalTeam, acceptInvite, findValidInvite } from "@/lib/auth/register";
import { assertSignupAllowed, sendVerificationEmail } from "@/lib/plans/signup";
import { createSession } from "@/lib/auth/session";
import { TEAM_COOKIE } from "@/lib/auth/jwt";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";

const schema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: emailSchema,
  password: passwordSchema,
  inviteToken: z.string().max(200).optional().nullable(),
  /** plans area: terms checkbox (required when auth.requireTerms) */
  acceptTerms: z.boolean().optional(),
});

export const POST = route(async (req) => {
  const ip = await clientIp();
  // coarse flood guard (bad requests included); the configurable per-IP sign-up limit is auth.signupRateLimit (assertSignupAllowed)
  const rl = await rateLimit(`register:${ip}`, LIMITS.register.limit * 10, LIMITS.register.window);
  if (!rl.ok) throw E.tooMany(rl.resetIn);
  const input = await body(req, schema);
  const reg = await registrationAllowed(input.inviteToken);
  if (!reg.allowed) throw E.forbidden("closed" in reg && reg.closed ? "Registration is closed on this LevantDeploy instance" : "Registration is invite-only on this LevantDeploy instance");
  // plans area: per-IP sign-up limit, terms, disposable-email blocklist (SignupError → 422 / 429)
  const viaInvite = !!input.inviteToken && !!(await findValidInvite(input.inviteToken));
  const policy = await assertSignupAllowed({ email: input.email, ip, acceptTerms: input.acceptTerms, viaInvite, firstUser: reg.firstUser });
  const { user, team } = await createUserWithPersonalTeam({ ...input, firstUser: reg.firstUser, verified: !policy.requireEmailVerification });
  if (!user.emailVerifiedAt) await sendVerificationEmail(user);
  let landing = team;
  if (input.inviteToken) {
    landing = await acceptInvite(input.inviteToken, user).catch(() => team);
  }
  await createSession(user.id);
  (await cookies()).set(TEAM_COOKIE, landing.slug, { path: "/", sameSite: "lax", maxAge: 365 * 86400 });
  await audit({ action: "user.register", userId: user.id, teamId: team.id, meta: { firstUser: reg.firstUser } });
  return json({ user: { id: user.id, email: user.email, name: user.name, isPlatformOwner: user.isPlatformOwner, emailVerified: !!user.emailVerifiedAt }, redirect: `/${landing.slug}` }, 201);
});
