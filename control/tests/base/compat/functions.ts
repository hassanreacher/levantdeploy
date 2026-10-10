import { FunctionsHttpError } from "@supabase/supabase-js";
import { api, ApiError, assert, check, eq, lbFetch, until } from "./lib";
import type { Ctx } from "./auth";

export const ECHO_FN = `// compat: echo function (deployed through the LevantDeploy API)
function claims(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const part = h.startsWith("Bearer ") ? h.slice(7).split(".")[1] : undefined;
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("fail")) return Response.json({ error: "asked to fail" }, { status: 418 });
  const c = claims(req);
  const body = req.method === "POST" ? await req.json().catch(() => null) : null;
  let db: unknown = null;
  if (url.searchParams.get("db")) {
    // call the project's own REST API from inside the function (internal URL + keys from the runtime env)
    const r = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/compat_countries?select=code&order=id", {
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: "Bearer " + Deno.env.get("SUPABASE_ANON_KEY") },
    });
    db = { status: r.status, rows: await r.json() };
  }
  return Response.json({
    slug: Deno.env.get("SUPABASE_FUNCTION_SLUG"),
    secret: Deno.env.get("COMPAT_SECRET") ?? null,
    method: req.method,
    body,
    role: c?.role ?? null,
    sub: c?.sub ?? null,
    db,
  });
});
`;

async function deploy(ref: string, slug: string, verifyJwt: boolean) {
  try {
    return await api("POST", `/api/v1/base/projects/${ref}/functions`, { slug, code: ECHO_FN, verifyJwt });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return api("PATCH", `/api/v1/base/projects/${ref}/functions/${slug}`, { code: ECHO_FN, verifyJwt });
    throw e;
  }
}

export async function functionsSuite(ctx: Ctx) {
  const F = "functions";
  const { a } = ctx.users;
  const secret = `s3cret-${Date.now()}`;

  const deployed = await check(F, "deploy two functions via the platform API (verifyJwt on / off)", async () => {
    await deploy(ctx.ref, "compat-echo", true);
    await deploy(ctx.ref, "compat-public", false);
    const list = await api<{ items: Array<{ slug: string; verifyJwt: boolean }> }>("GET", `/api/v1/base/projects/${ctx.ref}/functions`);
    const m = Object.fromEntries(list.items.map((f) => [f.slug, f.verifyJwt]));
    eq([m["compat-echo"], m["compat-public"]], [true, false], "verifyJwt flags");
  });
  if (!deployed) return;

  await check(F, "set a function secret via the platform API", async () => {
    const r = await api<{ items: Array<{ name: string }> }>("PUT", `/api/v1/base/projects/${ctx.ref}/secrets`, { set: { COMPAT_SECRET: secret } });
    assert(r.items.some((x) => x.name === "COMPAT_SECRET"), "secret not listed");
    return "names listed, values never returned";
  });

  await check(F, "functions.invoke with the user's JWT (POST JSON body)", async () => {
    const r = await until(
      async () => {
        const x = await a.sb.functions.invoke("compat-echo", { body: { hello: "levant" } });
        return !x.error && (x.data as { secret?: string }).secret === secret ? x : null;
      },
      "function to answer with the new secret",
      120_000,
      2000,
    );
    const d = r.data as { slug: string; body: { hello: string }; role: string; sub: string; method: string };
    eq(d.slug, "compat-echo", "SUPABASE_FUNCTION_SLUG");
    eq(d.body.hello, "levant", "body");
    eq(d.role, "authenticated", "JWT role");
    eq(d.sub, a.id, "JWT sub");
  });

  await check(F, "env secret visible inside the function", async () => {
    const r = await a.sb.functions.invoke("compat-echo", { method: "GET" });
    eq((r.data as { secret: string }).secret, secret, "COMPAT_SECRET");
  });

  await check(F, "functions.invoke with the anon key (verify_jwt accepts the anon JWT)", async () => {
    const r = await ctx.anon.functions.invoke("compat-echo", { body: {} });
    assert(!r.error, r.error?.message ?? "");
    eq((r.data as { role: string }).role, "anon", "role");
  });

  await check(F, "verify_jwt on: no / forged Authorization → 401", async () => {
    const none = await lbFetch(`${ctx.url}/functions/v1/compat-echo`, { method: "POST" });
    eq(none.status, 401, "without Authorization");
    const forged = await lbFetch(`${ctx.url}/functions/v1/compat-echo`, { method: "POST", headers: { Authorization: `Bearer ${ctx.anonKey.slice(0, -4)}AAAA` } });
    eq(forged.status, 401, "forged signature");
  });

  await check(F, "verify_jwt off: invocable without any key", async () => {
    const res = await lbFetch(`${ctx.url}/functions/v1/compat-public`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: 1 }) });
    eq(res.status, 200, "status");
    eq(((await res.json()) as { body: { x: number } }).body.x, 1, "body");
  });

  await check(F, "function error status surfaces as FunctionsHttpError", async () => {
    const r = await ctx.anon.functions.invoke("compat-echo?fail=1", { body: {} });
    assert(r.error instanceof FunctionsHttpError, `error ${r.error?.name}`);
    eq((r.error.context as Response).status, 418, "status");
  });

  await check(F, "function reaches the project's REST API (SUPABASE_URL + SUPABASE_ANON_KEY)", async () => {
    const r = await ctx.anon.functions.invoke("compat-echo?db=1", { body: {} });
    assert(!r.error, r.error?.message ?? "");
    const db = (r.data as { db: { status: number; rows: Array<{ code: string }> } }).db;
    eq(db.status, 200, "REST status");
    eq(db.rows.map((x) => x.code), ["LB", "JO", "SY"], "rows");
  });

  await check(F, "platform invoke tester (POST …/functions/:slug/invoke)", async () => {
    const r = await api<{ status: number; body: string }>("POST", `/api/v1/base/projects/${ctx.ref}/functions/compat-echo/invoke`, { method: "POST", body: JSON.stringify({ via: "platform" }) });
    eq(r.status, 200, "status");
    eq((JSON.parse(r.body) as { body: { via: string } }).body.via, "platform", "body");
  });

  await check(F, "unknown function → 404", async () => {
    const res = await lbFetch(`${ctx.url}/functions/v1/does-not-exist`, { headers: { Authorization: `Bearer ${ctx.anonKey}` } });
    eq(res.status, 404, "status");
  });

  await check(F, "delete a function via the platform API", async () => {
    await api("DELETE", `/api/v1/base/projects/${ctx.ref}/functions/compat-public`);
    await until(async () => (await lbFetch(`${ctx.url}/functions/v1/compat-public`, { method: "POST" })).status === 404, "404 after delete", 60_000, 2000);
  });
  await api("PUT", `/api/v1/base/projects/${ctx.ref}/secrets`, { remove: ["COMPAT_SECRET"] }).catch(() => {});
}
