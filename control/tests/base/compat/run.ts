/**
 * LevantBase client compatibility suite — entry point.
 *
 *   cd control/tests/base/compat && npm install
 *   LB_API=http://localhost:3111 LB_TOKEN=ld_… [LB_REF=<ref>] [LB_EDGE=<caddy ip>] NODE_EXTRA_CA_CERTS=caddy-root.crt \
 *     [LB_SMTP_HOST=compat-smtp LB_SMTP_API=http://<sink ip>:8025] npx tsx run.ts
 *
 * Without LB_REF a Base project is created through `POST /api/v1/base/projects` (and deleted afterwards unless
 * LB_KEEP=1). `./run.sh` does all the wiring for the dev sandbox (Caddy CA, edge address, SMTP sink container).
 * Exit code = number of failed checks. A JSON + Markdown report is written to results/.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, cfg, check, client, results, sleep, sql, until } from "./lib";
import { authSuite, newUser, type Ctx } from "./auth";
import { dbSuite, SCHEMA_SQL } from "./db";
import { realtimeSuite } from "./realtime";
import { storageSuite } from "./storage";
import { functionsSuite } from "./functions";
import { graphqlSuite, securitySuite } from "./platform";
import { emailSuite } from "./email";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = (name: string) => JSON.parse(fs.readFileSync(path.join(here, "node_modules", name, "package.json"), "utf8")).version as string;

type ProjectDTO = { ref: string; status: string; statusMessage?: string | null; apiUrl: string; versions: Record<string, string> };

async function project(ref: string) {
  return (await api<{ project: ProjectDTO }>("GET", `/api/v1/base/projects/${ref}`)).project;
}

async function main() {
  if (!cfg.token) throw new Error("LB_TOKEN (LevantDeploy API token) is required");
  const started = Date.now();
  let ref = cfg.ref;
  let created = false;
  if (!ref) {
    await check("platform", "create a Base project via POST /api/v1/base/projects", async () => {
      const r = await api<{ project: ProjectDTO }>("POST", "/api/v1/base/projects", { team: cfg.team, name: `compat-${Date.now().toString(36)}` });
      ref = r.project.ref;
      created = true;
      const p = await until(async () => {
        const x = await project(ref);
        if (x.status === "ERROR") throw new Error(`provisioning failed: ${x.statusMessage}`);
        return x.status === "ACTIVE" ? x : null;
      }, "ACTIVE", 15 * 60_000, 3000);
      return `${p.ref} ACTIVE after ${Math.round((Date.now() - started) / 1000)} s`;
    });
    if (!ref) throw new Error("no project");
  }
  const p = await project(ref);
  // dev sandbox: attach the SMTP sink container to the project's egress network (only auth/functions have egress)
  const sink = process.env.LB_SMTP_CONTAINER;
  if (sink) {
    const net = `lb_${ref}_egress`;
    try {
      execFileSync("docker", ["network", "connect", net, sink], { stdio: "pipe" });
    } catch (e) {
      if (!/already exists/.test(String((e as { stderr?: Buffer }).stderr ?? ""))) throw e;
    }
    const ip = execFileSync("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink], { encoding: "utf8" }).trim();
    cfg.smtpHost = sink;
    cfg.smtpApi = `http://${ip}:8025`;
  }
  if (p.status !== "ACTIVE") throw new Error(`project ${ref} is ${p.status}`);
  const keys = await api<{ url: string; anonKey: string; serviceRoleKey: string }>("GET", `/api/v1/base/projects/${ref}/keys?reveal=service_role`);
  const ctx = {
    ref,
    url: keys.url,
    anonKey: keys.anonKey,
    serviceKey: keys.serviceRoleKey,
    admin: client(keys.url, keys.serviceRoleKey),
    anon: client(keys.url, keys.anonKey),
  } as Ctx;
  console.log(`project ${ref} → ${ctx.url}\n`);

  await check("platform", "project API reachable over HTTPS through Caddy (verified certificate)", async () => {
    const { lbFetch } = await import("./lib");
    const res = await lbFetch(`${ctx.url}/auth/v1/health`, { headers: { apikey: ctx.anonKey } });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
  });
  const schemaOk = await check("platform", "schema, RLS policies, functions, publication via POST …/sql", async () => {
    await sql(ref, SCHEMA_SQL);
  });
  if (!schemaOk) throw new Error("schema setup failed");

  ctx.users = { a: await newUser(ctx, "alice"), b: await newUser(ctx, "bob") };

  await authSuite(ctx);
  await dbSuite(ctx);
  await realtimeSuite(ctx);
  await storageSuite(ctx);
  await functionsSuite(ctx);
  await graphqlSuite(ctx);
  await securitySuite(ctx);
  await emailSuite(ctx);

  // ── report ──
  const versions = { "@supabase/supabase-js": pkgVersion("@supabase/supabase-js"), "@supabase/auth-js": pkgVersion("@supabase/auth-js"), "@supabase/postgrest-js": pkgVersion("@supabase/postgrest-js"), "@supabase/realtime-js": pkgVersion("@supabase/realtime-js"), "@supabase/storage-js": pkgVersion("@supabase/storage-js"), "@supabase/functions-js": pkgVersion("@supabase/functions-js"), node: process.version };
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const md = [
    `| # | Area | Check | Result | Detail |`,
    `|---|---|---|---|---|`,
    ...results.map((r, i) => `| ${i + 1} | ${r.area} | ${r.name.replace(/\|/g, "\\|")} | ${r.status === "pass" ? "PASS" : r.status === "fail" ? "**FAIL**" : "skip"} | ${r.detail.replace(/\|/g, "\\|").slice(0, 120)} |`),
  ].join("\n");
  fs.mkdirSync(path.join(here, "results"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(here, "results", `compat-${stamp}.json`), JSON.stringify({ ref, versions, server: p.versions, pass, fail, skipped, results }, null, 2));
  fs.writeFileSync(path.join(here, "results", "latest.md"), `${md}\n\nclient: ${JSON.stringify(versions)}\nserver: ${JSON.stringify(p.versions)}\n`);
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped (${results.length} checks, ${Math.round((Date.now() - started) / 1000)} s)`);
  console.log(`client: ${JSON.stringify(versions)}\nserver: ${JSON.stringify(p.versions)}`);

  if (created && !cfg.keep) {
    await api("DELETE", `/api/v1/base/projects/${ref}?confirm=${ref}`).catch((e) => console.error("delete failed:", (e as Error).message));
    console.log(`deleting ${ref}`);
  }
  await sleep(100);
  process.exit(fail);
}

main().catch((e) => {
  console.error(e);
  process.exit(100);
});
