/**
 * builder-agents e2e (b) verification: real supabase-js (inside the runtime image, on levant_net) against an app's
 * LevantBase backend — two users, own-rows-only, cross-user writes denied, anon sees nothing.
 *   set -a; . ./.env.bagents; set +a; npx tsx scripts/builder-agents-verify-rls.ts <ref> [table] [titleColumn]
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { baseKeys, runSql } from "@/lib/base";
(async () => {
  const ref = process.argv[2];
  const k = await baseKeys(ref);
  const sql = await runSql(ref, "select tablename, rowsecurity from pg_tables where schemaname='public'; ", {});
  console.log("tables:", JSON.stringify(sql.rows));
  const pol = await runSql(ref, "select policyname, cmd, roles::text from pg_policies where schemaname='public' order by 1", {});
  console.log("policies:", JSON.stringify(pol.rows));
  const conf = await runSql(ref, "select count(*) from auth.users", {});
  console.log("auth users before:", JSON.stringify(conf.rows));
  try {
    const out = execFileSync("docker", ["run", "--rm", "--network", "levant_net", "-e", `SB_URL=http://base-${ref}:8000`, "-e", "SB_ANON", "-e", `TABLE=${process.argv[3] ?? "todos"}`, "-e", `TITLE_COL=${process.argv[4] ?? "title"}`, "-v", `${path.join(__dirname, "builder-agents-verify-rls.mjs")}:/opt/levant/base/verify-rls.mjs:ro`, "-w", "/opt/levant/base", "--entrypoint", "node", "levant/builder-runtime:next15", "/opt/levant/base/verify-rls.mjs"], { env: { ...process.env, SB_ANON: k.anonKey }, encoding: "utf8" });
    console.log(out);
  } catch (e) {
    console.log((e as { stdout?: string }).stdout, (e as { stderr?: string }).stderr);
  }
  process.exit(0);
})();
