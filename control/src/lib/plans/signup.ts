import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { randomToken, sha256 } from "@/lib/crypto";
import { sendMail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Open registration, email verification and sign-up abuse protection (plans area). Worker-safe.
 */

/** Built-in disposable / throwaway email domains (extend via the `auth.disposableDomains` setting). */
export const DISPOSABLE_DOMAINS = [
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com", "anonaddy.me", "burnermail.io", "discard.email", "dispostable.com",
  "dropmail.me", "emailondeck.com", "fakeinbox.com", "fakemail.net", "getairmail.com", "getnada.com", "guerrillamail.biz", "guerrillamail.com",
  "guerrillamail.de", "guerrillamail.info", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "harakirimail.com", "inboxbear.com",
  "incognitomail.org", "jetable.org", "mail-temp.com", "mail.tm", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net",
  "mailnesia.com", "mailpoof.com", "mintemail.com", "moakt.com", "mohmal.com", "mytemp.email", "nada.email", "sharklasers.com", "spam4.me",
  "spambox.us", "spamgourmet.com", "temp-mail.io", "temp-mail.org", "tempail.com", "tempmail.com", "tempmail.dev", "tempmail.net",
  "tempmailo.com", "tempr.email", "throwawaymail.com", "trash-mail.com", "trashmail.com", "trashmail.de", "trashmail.net", "yopmail.com",
  "yopmail.fr", "yopmail.net", "emailfake.com", "fakemailgenerator.com", "minuteinbox.com", "tmpmail.net", "tmpmail.org", "luxusmail.org",
  "linshiyouxiang.net", "mailsac.com", "inboxkitten.com", "1secmail.com", "1secmail.net", "1secmail.org", "byom.de", "spamdecoy.net",
];

export function emailDomain(email: string) {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

/** true when the domain (or a parent domain) is in the list. */
export function isDisposableDomain(domain: string, extra: string[] = []): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const set = new Set([...DISPOSABLE_DOMAINS, ...extra.map((x) => x.toLowerCase())]);
  const parts = d.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join("."))) return true;
  return false;
}

export type SignupPolicy = {
  registration: "open" | "invite" | "closed";
  lockedByEnv: boolean;
  requireEmailVerification: boolean;
  blockDisposableEmails: boolean;
  disposableDomains: string[];
  signupRateLimit: { limit: number; windowMinutes: number };
  requireTerms: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
};

export async function signupPolicy(): Promise<SignupPolicy> {
  const [registration, requireEmailVerification, blockDisposableEmails, disposableDomains, signupRateLimit, requireTerms, termsUrl, privacyUrl] = await Promise.all([
    getSetting("platform.registration"),
    getSetting("auth.requireEmailVerification"),
    getSetting("auth.blockDisposableEmails"),
    getSetting("auth.disposableDomains"),
    getSetting("auth.signupRateLimit"),
    getSetting("auth.requireTerms"),
    getSetting("auth.termsUrl"),
    getSetting("auth.privacyUrl"),
  ]);
  const lockedByEnv = process.env.REGISTRATION === "open";
  return {
    registration: lockedByEnv ? "open" : registration,
    lockedByEnv,
    requireEmailVerification,
    blockDisposableEmails,
    disposableDomains,
    signupRateLimit,
    requireTerms,
    termsUrl,
    privacyUrl,
  };
}

export class SignupError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public resetIn?: number,
  ) {
    super(message);
  }
  publicError() {
    return { status: this.status, body: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}) } };
  }
}

/**
 * Checks done before creating an account through open registration (invites and the first user skip
 * the disposable check but not the rate limit). Throws SignupError.
 */
export async function assertSignupAllowed(input: { email: string; ip: string; acceptTerms?: boolean; viaInvite?: boolean; firstUser?: boolean }) {
  const policy = await signupPolicy();
  if (!input.firstUser) {
    const w = policy.signupRateLimit;
    const rl = await rateLimit(`signup:${input.ip}`, w.limit, w.windowMinutes * 60);
    if (!rl.ok) throw new SignupError(429, "RATE_LIMITED", `Too many sign-ups from your network. Try again in ${Math.ceil(rl.resetIn / 60)} min.`, undefined, rl.resetIn);
  }
  if (policy.requireTerms && !input.firstUser && !input.acceptTerms) {
    throw new SignupError(422, "VALIDATION", "Please accept the terms to continue", { acceptTerms: "You must accept the terms of service" });
  }
  if (!input.viaInvite && !input.firstUser && policy.blockDisposableEmails && isDisposableDomain(emailDomain(input.email), policy.disposableDomains)) {
    throw new SignupError(422, "VALIDATION", "Disposable email addresses can't be used", { email: "Please use a permanent email address" });
  }
  return policy;
}

// ───────────────────────────── Email verification ─────────────────────────────

const VERIFY_TTL_MS = 48 * 3600_000;

/** Creates a verification link (only the hash is stored) and emails it. In dev (no SMTP) the link is printed by sendMail. */
export async function sendVerificationEmail(user: { id: string; email: string; name: string }) {
  const token = randomToken(24);
  await db.emailVerification.create({ data: { userId: user.id, email: user.email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) } });
  const url = appUrl(`/verify-email?token=${token}`);
  const name = (await getSetting("platform.name").catch(() => "LevantDeploy")) as string;
  await sendMail({
    to: user.email,
    subject: `Verify your email for ${name}`,
    text: `Hi ${user.name},\n\nConfirm your email address to start deploying on ${name}:\n\n${url}\n\nThe link expires in 48 hours. If you didn't create an account, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.6"><p>Hi ${esc(user.name)},</p><p>Confirm your email address to start deploying on ${esc(name)}:</p><p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Verify email</a></p><p style="color:#666;font-size:12px">Or open ${url}<br>The link expires in 48 hours.</p></div>`,
  }).catch((e) => console.warn("[plans] verification email failed:", (e as Error).message));
  return { url };
}

/** Resend (rate limited per user: 3 / 15 min). */
export async function resendVerification(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true } });
  if (!user) throw new SignupError(404, "NOT_FOUND", "User not found");
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  const rl = await rateLimit(`verify-resend:${userId}`, 3, 900);
  if (!rl.ok) throw new SignupError(429, "RATE_LIMITED", `Please wait ${Math.ceil(rl.resetIn / 60)} min before requesting another email.`);
  await sendVerificationEmail(user);
  return { alreadyVerified: false };
}

/** Consumes a token. Returns the verified user id, or throws SignupError(400) when invalid/expired. */
export async function verifyEmailToken(token: string) {
  const row = await db.emailVerification.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { select: { id: true, email: true, emailVerifiedAt: true } } } });
  if (!row || row.expiresAt < new Date()) throw new SignupError(400, "BAD_REQUEST", "This verification link is invalid or has expired. Request a new one from the dashboard.");
  if (row.user.email.toLowerCase() !== row.email.toLowerCase()) throw new SignupError(400, "BAD_REQUEST", "This link was sent to a different email address.");
  if (!row.usedAt) await db.emailVerification.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  if (!row.user.emailVerifiedAt) await db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  return { userId: row.userId, email: row.user.email };
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
