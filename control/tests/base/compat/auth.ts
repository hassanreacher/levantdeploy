import type { SupabaseClient } from "@supabase/supabase-js";
import { assert, check, client, eq, ok, uniq } from "./lib";

export type Ctx = {
  ref: string;
  url: string;
  anonKey: string;
  serviceKey: string;
  admin: SupabaseClient;
  anon: SupabaseClient;
  users: Record<"a" | "b", { email: string; password: string; id: string; token: string; sb: SupabaseClient }>;
};

const PASSWORD = "Compat-pw-12345!";

/** a signed-in client for a fresh user (autoconfirm on) */
export async function newUser(ctx: Pick<Ctx, "url" | "anonKey">, prefix: string) {
  const email = `${uniq(prefix)}@compat.test`;
  const sb = client(ctx.url, ctx.anonKey);
  const r = ok(await sb.auth.signUp({ email, password: PASSWORD }), "signUp");
  assert(r.session, "signUp returned no session (autoconfirm off?)");
  return { email, password: PASSWORD, id: r.user!.id, token: r.session.access_token, sb };
}

export async function authSuite(ctx: Ctx) {
  const A = "auth";
  const sb = client(ctx.url, ctx.anonKey);
  const email = `${uniq("signup")}@compat.test`;
  let session: { access_token: string; refresh_token: string } | null = null;

  await check(A, "signUp (email + password, autoconfirm) returns a session", async () => {
    const r = ok(await sb.auth.signUp({ email, password: PASSWORD, options: { data: { plan: "free" } } }), "signUp");
    assert(r.user?.email === email, "user email");
    assert(r.session?.access_token, "no session");
    return `user ${r.user!.id.slice(0, 8)}…, confirmed_at set: ${!!r.user!.email_confirmed_at}`;
  });

  await check(A, "signInWithPassword", async () => {
    const r = ok(await sb.auth.signInWithPassword({ email, password: PASSWORD }), "signIn");
    session = r.session;
    assert(session?.access_token && session.refresh_token, "no tokens");
    return `expires_in ${r.session!.expires_in}s`;
  });

  await check(A, "signInWithPassword with a wrong password is rejected", async () => {
    const r = await client(ctx.url, ctx.anonKey).auth.signInWithPassword({ email, password: "wrong-password" });
    assert(r.error, "expected an error");
    eq(r.error.status, 400, "status");
    return r.error.message;
  });

  await check(A, "getUser (JWT validated by the server)", async () => {
    const r = ok(await sb.auth.getUser(), "getUser");
    eq(r.user.email, email, "email");
    eq(r.user.user_metadata?.plan, "free", "user_metadata.plan");
  });

  await check(A, "updateUser (metadata)", async () => {
    const r = ok(await sb.auth.updateUser({ data: { plan: "pro", nickname: "compat" } }), "updateUser");
    eq(r.user.user_metadata?.plan, "pro", "plan");
    const again = ok(await sb.auth.getUser(), "getUser");
    eq(again.user.user_metadata?.nickname, "compat", "nickname");
  });

  await check(A, "updateUser (password) → login with the new password", async () => {
    ok(await sb.auth.updateUser({ password: PASSWORD + "x" }), "updateUser");
    ok(await client(ctx.url, ctx.anonKey).auth.signInWithPassword({ email, password: PASSWORD + "x" }), "login new pw");
  });

  await check(A, "refreshSession returns a new access token", async () => {
    const before = (await sb.auth.getSession()).data.session!;
    const r = ok(await sb.auth.refreshSession(), "refresh");
    assert(r.session && r.session.refresh_token !== before.refresh_token, "refresh token not rotated");
    return "refresh token rotated";
  });

  await check(A, "signOut revokes the refresh token", async () => {
    const s = (await sb.auth.getSession()).data.session!;
    ok(await sb.auth.signOut(), "signOut");
    const other = client(ctx.url, ctx.anonKey);
    const r = await other.auth.refreshSession({ refresh_token: s.refresh_token });
    assert(r.error, "refresh after signOut should fail");
    return r.error.message;
  });

  await check(A, "getSession is empty after signOut", async () => {
    eq((await sb.auth.getSession()).data.session, null, "session");
  });

  // ── admin API (service_role key) ──
  const adminEmail = `${uniq("admin")}@compat.test`;
  let adminUserId = "";
  await check(A, "admin.createUser (email_confirm) with service_role key", async () => {
    const r = ok(await ctx.admin.auth.admin.createUser({ email: adminEmail, password: PASSWORD, email_confirm: true, app_metadata: { role: "tester" } }), "createUser");
    adminUserId = r.user.id;
    eq(r.user.app_metadata?.role, "tester", "app_metadata.role");
  });

  await check(A, "admin.listUsers finds the created user", async () => {
    const r = ok(await ctx.admin.auth.admin.listUsers({ page: 1, perPage: 1000 }), "listUsers");
    assert(r.users.some((u) => u.id === adminUserId), "user not listed");
    return `${r.users.length} users`;
  });

  await check(A, "admin.getUserById + updateUserById", async () => {
    ok(await ctx.admin.auth.admin.updateUserById(adminUserId, { user_metadata: { by: "admin" } }), "update");
    const r = ok(await ctx.admin.auth.admin.getUserById(adminUserId), "get");
    eq(r.user.user_metadata?.by, "admin", "metadata");
  });

  await check(A, "admin API refused with the anon key", async () => {
    const r = await ctx.anon.auth.admin.listUsers();
    assert(r.error, "anon key could list users");
    return `${r.error.status ?? ""} ${r.error.message}`.trim();
  });

  await check(A, "admin.generateLink magiclink → verifyOtp(token_hash) signs in", async () => {
    const r = ok(await ctx.admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail }), "generateLink");
    assert(r.properties.action_link.startsWith(ctx.url + "/auth/v1/verify?"), `action_link host: ${r.properties.action_link}`);
    const v = ok(await client(ctx.url, ctx.anonKey).auth.verifyOtp({ token_hash: r.properties.hashed_token, type: "magiclink" }), "verifyOtp");
    eq(v.user?.id, adminUserId, "user");
    assert(v.session?.access_token, "no session");
    return "action_link on the project URL";
  });

  await check(A, "admin.generateLink recovery → verifyOtp(email OTP) signs in", async () => {
    const r = ok(await ctx.admin.auth.admin.generateLink({ type: "recovery", email: adminEmail }), "generateLink");
    assert(/^\d{6}$/.test(r.properties.email_otp), `email_otp ${r.properties.email_otp}`);
    const v = ok(await client(ctx.url, ctx.anonKey).auth.verifyOtp({ email: adminEmail, token: r.properties.email_otp, type: "recovery" }), "verifyOtp");
    assert(v.session?.access_token, "no session");
  });

  await check(A, "action_link redirect (GET /auth/v1/verify) hands out tokens in the URL fragment", async () => {
    const r = ok(await ctx.admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail, options: { redirectTo: "http://localhost:3000/welcome" } }), "generateLink");
    const { lbFetch } = await import("./lib");
    const res = await lbFetch(r.properties.action_link, { redirect: "manual" });
    const loc = res.headers.get("location") ?? "";
    assert(res.status === 303 || res.status === 302, `status ${res.status}`);
    assert(loc.startsWith("http://localhost:3000/welcome#access_token="), `location ${loc.slice(0, 80)}`);
    return `${res.status} → redirectTo#access_token=…`;
  });

  await check(A, "admin.deleteUser", async () => {
    ok(await ctx.admin.auth.admin.deleteUser(adminUserId), "deleteUser");
    const r = await ctx.admin.auth.admin.getUserById(adminUserId);
    assert(r.error, "user still exists");
  });

  await check(A, "anonymous sign-in refused while disabled (default)", async () => {
    const r = await client(ctx.url, ctx.anonKey).auth.signInAnonymously();
    assert(r.error, "anonymous sign-in should be disabled by default");
    return r.error.message;
  });
}
