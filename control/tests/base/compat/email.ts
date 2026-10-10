import { api, assert, cfg, check, client, eq, lbFetch, ok, skip, until, uniq } from "./lib";
import type { Ctx } from "./auth";

type Mail = { from: string; to: string[]; data: string; at: string };

/** decode quoted-printable + HTML entities so links and codes can be matched */
export function decodeMail(raw: string): string {
  const body = raw.includes("quoted-printable") ? raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw;
  return body.replace(/&amp;/g, "&").replace(/&#43;/g, "+").replace(/&#61;/g, "=");
}

async function mails(): Promise<Mail[]> {
  return (await (await fetch(`${cfg.smtpApi}/messages`)).json()) as Mail[];
}
async function mailFor(email: string, match: (body: string) => boolean = () => true): Promise<string> {
  return until(
    async () => {
      const m = (await mails()).filter((x) => x.to.some((t) => t.includes(email))).map((x) => decodeMail(x.data));
      return m.reverse().find(match) ?? null;
    },
    `mail to ${email}`,
    30_000,
    500,
  );
}

async function authSettings(ctx: Ctx) {
  const res = await lbFetch(`${ctx.url}/auth/v1/settings`, { headers: { apikey: ctx.anonKey } });
  return (await res.json()) as { mailer_autoconfirm: boolean; external: { anonymous_users: boolean } };
}

const TEMPLATE = `<h2>LevantBase compat</h2><p>Your code: <b>{{ .Token }}</b></p><p><a href="{{ .ConfirmationURL }}">Log in</a></p>`;

export async function emailSuite(ctx: Ctx) {
  const E = "auth-email";
  if (!cfg.smtpApi || !cfg.smtpHost) {
    for (const n of ["email confirmation via SMTP", "OTP via email", "password recovery mail", "anonymous sign-in"]) skip(E, n, "no SMTP sink (LB_SMTP_HOST / LB_SMTP_API)");
    return;
  }
  const PASSWORD = "Compat-pw-12345!";

  const applied = await check(E, "switch settings via the platform API: confirmations on, SMTP, anonymous users, custom template", async () => {
    await api("PATCH", `/api/v1/base/projects/${ctx.ref}/auth`, {
      auth: { emailAutoconfirm: false, enableAnonymousUsers: true, siteUrl: "http://localhost:3000" },
      smtp: { host: cfg.smtpHost, port: cfg.smtpPort, user: "", pass: null, adminEmail: "noreply@compat.test", senderName: "LevantBase compat" },
      templates: { magic_link: { subject: "Your compat code", body: TEMPLATE } },
    });
    const s = await until(async () => {
      const x = await authSettings(ctx).catch(() => null);
      return x && !x.mailer_autoconfirm && x.external.anonymous_users ? x : null;
    }, "auth to restart with the new settings", 180_000, 2000);
    return `mailer_autoconfirm=${s.mailer_autoconfirm}, anonymous_users=${s.external.anonymous_users}`;
  });
  if (!applied) return;

  const email = `${uniq("confirm")}@compat.test`;
  await check(E, "signUp with confirmations on → no session, confirmation mail delivered", async () => {
    const r = ok(await client(ctx.url, ctx.anonKey).auth.signUp({ email, password: PASSWORD, options: { emailRedirectTo: "http://localhost:3000/confirmed" } }), "signUp");
    eq(r.session, null, "session");
    assert(r.user && !r.user.email_confirmed_at, "user should be unconfirmed");
    await mailFor(email, (b) => b.includes("/auth/v1/verify?"));
  });
  await check(E, "signIn before confirming → 'Email not confirmed'", async () => {
    const r = await client(ctx.url, ctx.anonKey).auth.signInWithPassword({ email, password: PASSWORD });
    assert(r.error, "login should fail");
    assert(/not confirmed/i.test(r.error.message), r.error.message);
  });
  await check(E, "confirmation link from the mail → redirect with tokens, then signIn works", async () => {
    const body = await mailFor(email, (b) => b.includes("/auth/v1/verify?"));
    const link = body.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/)?.[0];
    assert(link, "no link in mail");
    assert(link.startsWith(ctx.url), `link not on the project URL: ${link.slice(0, 60)}`);
    const res = await lbFetch(link, { redirect: "manual" });
    const loc = res.headers.get("location") ?? "";
    assert(loc.startsWith("http://localhost:3000/confirmed#access_token="), `location ${loc.slice(0, 80)}`);
    ok(await client(ctx.url, ctx.anonKey).auth.signInWithPassword({ email, password: PASSWORD }), "signIn");
  });
  await check(E, "signInWithOtp → code from the custom mail template → verifyOtp", async () => {
    ok(await client(ctx.url, ctx.anonKey).auth.signInWithOtp({ email, options: { shouldCreateUser: false } }), "signInWithOtp");
    const body = await mailFor(email, (b) => b.includes("Your code:"));
    assert(/Subject: Your compat code/.test(body), "custom subject not used");
    const code = body.match(/Your code: <b>(\d{6})<\/b>/)?.[1];
    assert(code, "no code");
    const v = ok(await client(ctx.url, ctx.anonKey).auth.verifyOtp({ email, token: code, type: "email" }), "verifyOtp");
    assert(v.session?.access_token, "no session");
    return "template served by the gateway to GoTrue";
  });
  await check(E, "resetPasswordForEmail → recovery mail", async () => {
    // another address: GoTrue allows one mail per address and minute (GOTRUE_SMTP_MAX_FREQUENCY)
    const other = `${uniq("reset")}@compat.test`;
    ok(await ctx.admin.auth.admin.createUser({ email: other, password: PASSWORD, email_confirm: true }), "createUser");
    ok(await client(ctx.url, ctx.anonKey).auth.resetPasswordForEmail(other, { redirectTo: "http://localhost:3000/reset" }), "reset");
    const body = await mailFor(other, (b) => /type=recovery/.test(b));
    assert(/redirect_to=http:\/\/localhost:3000\/reset/.test(body), "redirect_to missing");
  });
  await check(E, "signInAnonymously (enabled in settings)", async () => {
    const sb = client(ctx.url, ctx.anonKey);
    const r = ok(await sb.auth.signInAnonymously(), "signInAnonymously");
    assert(r.user?.is_anonymous, "is_anonymous");
    const who = ok(await sb.rpc("compat_whoami"), "rpc") as { role: string; uid: string };
    eq([who.role, who.uid], ["authenticated", r.user!.id], "JWT role/uid");
  });

  await check(E, "restore defaults (autoconfirm on, no SMTP, anonymous off)", async () => {
    await api("PATCH", `/api/v1/base/projects/${ctx.ref}/auth`, { auth: { emailAutoconfirm: true, enableAnonymousUsers: false }, smtp: null, templates: { magic_link: null } });
    await until(async () => {
      const x = await authSettings(ctx).catch(() => null);
      return x && x.mailer_autoconfirm && !x.external.anonymous_users;
    }, "auth to restart", 180_000, 2000);
  });
}
