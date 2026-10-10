import { api, ApiError, assert, check, eq, lbFetch, ok } from "./lib";
import type { Ctx } from "./auth";

async function gql(ctx: Ctx, key: string, query: string, token?: string) {
  const res = await lbFetch(`${ctx.url}/graphql/v1`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: (await res.json()) as { data?: any; errors?: Array<{ message: string }> } };
}

export async function graphqlSuite(ctx: Ctx) {
  const G = "graphql";
  await check(G, "pg_graphql query through /graphql/v1 (anon, RLS-filtered)", async () => {
    const r = await gql(ctx, ctx.anonKey, `{ compat_countriesCollection(orderBy: [{ id: AscNullsLast }]) { edges { node { code name } } } }`);
    eq(r.status, 200, "status");
    assert(!r.json.errors, JSON.stringify(r.json.errors));
    eq(r.json.data.compat_countriesCollection.edges.map((e: { node: { code: string } }) => e.node.code), ["LB", "JO", "SY"], "codes");
  });
  await check(G, "GraphQL relationships + filter", async () => {
    const r = await gql(ctx, ctx.anonKey, `{ compat_citiesCollection(filter: { population: { gt: 3000000 } }) { edges { node { name compat_countries { code } } } } }`);
    assert(!r.json.errors, JSON.stringify(r.json.errors));
    eq(r.json.data.compat_citiesCollection.edges.map((e: { node: { name: string; compat_countries: { code: string } } }) => `${e.node.name}/${e.node.compat_countries.code}`), ["Amman/JO"], "rows");
  });
  await check(G, "GraphQL with a user JWT respects RLS", async () => {
    const r = await gql(ctx, ctx.anonKey, `{ compat_todosCollection { edges { node { title } } } }`, ctx.users.a.token);
    assert(!r.json.errors, JSON.stringify(r.json.errors));
    const anon = await gql(ctx, ctx.anonKey, `{ compat_todosCollection { edges { node { title } } } }`);
    const n = r.json.data.compat_todosCollection.edges.length;
    assert(n >= 2, `user rows ${n}`);
    eq(anon.json.data?.compat_todosCollection?.edges?.length ?? 0, 0, "anon rows");
    return `user ${n} rows, anon 0`;
  });
  await check(G, "GraphQL mutation (insertInto…Collection) as a user", async () => {
    const r = await gql(ctx, ctx.anonKey, `mutation { insertIntocompat_todosCollection(objects: [{ title: "from graphql" }]) { affectedCount records { title } } }`, ctx.users.a.token);
    assert(!r.json.errors, JSON.stringify(r.json.errors));
    eq(r.json.data.insertIntocompat_todosCollection.affectedCount, 1, "affectedCount");
  });
}

export async function securitySuite(ctx: Ctx) {
  const K = "keys";
  await check(K, "requests without an apikey are refused (REST, Auth, GraphQL → 401; Storage → 4xx)", async () => {
    const out: string[] = [];
    for (const p of ["/rest/v1/compat_countries", "/auth/v1/user", "/graphql/v1"]) {
      const res = await lbFetch(ctx.url + p, p === "/graphql/v1" ? { method: "POST", body: "{}" } : {});
      assert(res.status === 401, `${p} → ${res.status}`);
      out.push(String(res.status));
    }
    // like upstream (and hosted) the gateway has no key-auth on /storage/v1 (public objects need no key); the storage
    // server itself refuses unauthenticated bucket access
    const st = await lbFetch(`${ctx.url}/storage/v1/bucket`);
    assert(st.status >= 400 && st.status < 500, `/storage/v1/bucket → ${st.status}`);
    out.push(String(st.status));
    return out.join(" / ");
  });
  await check(K, "a key signed with another secret is refused", async () => {
    const [h, p] = ctx.anonKey.split(".");
    const forged = `${h}.${p}.${Buffer.from("not-the-signature").toString("base64url")}`;
    const res = await lbFetch(`${ctx.url}/rest/v1/compat_countries`, { headers: { apikey: forged, Authorization: `Bearer ${forged}` } });
    assert(res.status === 401, `status ${res.status}`);
  });
  await check(K, "service_role: full access (bypasses RLS, admin APIs, OpenAPI root)", async () => {
    const res = await lbFetch(`${ctx.url}/rest/v1/`, { headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` } });
    eq(res.status, 200, "OpenAPI root with service key");
    const t = ok(await ctx.admin.from("compat_todos").select("id"), "select");
    assert(t.length >= 2, "service role sees all rows");
  });
  await check(K, "anon: OpenAPI root not exposed", async () => {
    const res = await lbFetch(`${ctx.url}/rest/v1/`, { headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}` } });
    assert(res.status === 401 || res.status === 403, `status ${res.status}`);
    return `${res.status}`;
  });
  await check(K, "/pg (postgres-meta) refused for anon, allowed for service_role", async () => {
    const anon = await lbFetch(`${ctx.url}/pg/tables`, { headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}` } });
    eq(anon.status, 403, "anon");
    const user = await lbFetch(`${ctx.url}/pg/tables`, { headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.users.a.token}` } });
    assert(user.status === 403 || user.status === 401, `user JWT → ${user.status}`);
    const none = await lbFetch(`${ctx.url}/pg/tables`);
    eq(none.status, 401, "no key");
    const svc = await lbFetch(`${ctx.url}/pg/tables?included_schemas=public`, { headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` } });
    eq(svc.status, 200, "service");
    const tables = (await svc.json()) as Array<{ name: string }>;
    assert(tables.some((t) => t.name === "compat_todos"), "compat_todos missing");
  });
  await check(K, "API host serves no Studio (/ → 404)", async () => {
    const res = await lbFetch(`${ctx.url}/`);
    assert(res.status === 404 || res.status === 401, `status ${res.status}`);
  });
  await check(K, "platform API: anon key public (VIEWER), service key requires ADMIN reveal", async () => {
    const k = await api<{ url: string; anonKey: string; serviceRoleKey?: string }>("GET", `/api/v1/base/projects/${ctx.ref}/keys`);
    eq(k.url, ctx.url, "url");
    eq(k.serviceRoleKey, undefined, "service key without reveal");
    const r = await api<{ serviceRoleKey: string }>("GET", `/api/v1/base/projects/${ctx.ref}/keys?reveal=service_role`);
    eq(r.serviceRoleKey, ctx.serviceKey, "revealed key");
  });
  await check(K, "platform API: unknown project → 404, no token → 401", async () => {
    try {
      await api("GET", `/api/v1/base/projects/aaaaaaaaaaaaaaaaaaaa`);
      throw new Error("expected 404");
    } catch (e) {
      eq((e as ApiError).status, 404, "status");
    }
    const res = await fetch(`${process.env.LB_API ?? "http://localhost:3111"}/api/v1/base/projects/${ctx.ref}`);
    eq(res.status, 401, "no token");
  });
  await check(K, "auth settings endpoint (public) reflects the project config", async () => {
    const res = await lbFetch(`${ctx.url}/auth/v1/settings`, { headers: { apikey: ctx.anonKey } });
    const s = (await res.json()) as { external: { email: boolean }; mailer_autoconfirm: boolean };
    eq(s.external.email, true, "email provider");
    return `mailer_autoconfirm=${s.mailer_autoconfirm}`;
  });
}
