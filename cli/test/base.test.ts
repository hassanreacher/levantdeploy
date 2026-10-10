import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baseEnv, bundleFunction, compareMigrations, functionsConfig, mergeEnvFile, migrationBatches, needsNoTransaction, parseEnvFile, parseKeyValues,
  parseMigrationName, planMigrations, readMigrations, splitSql,
} from "../src/base/lib.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "levant-base-"));

describe("migrations", () => {
  it("parses Supabase CLI file names", () => {
    expect(parseMigrationName("20240101120000_create_todos.sql")).toEqual({ version: "20240101120000", name: "create_todos" });
    expect(parseMigrationName("001_init.sql")).toEqual({ version: "001", name: "init" });
    expect(parseMigrationName("seed.sql")).toEqual({ version: "seed", name: "seed" });
  });

  it("reads *.sql sorted by version (numeric, not lexicographic for different lengths)", () => {
    const d = tmp();
    for (const f of ["10_c.sql", "2_b.sql", "1_a.sql", "README.md", "20240101000000_x.sql"]) fs.writeFileSync(path.join(d, f), `-- ${f}`);
    expect(readMigrations(d).map((m) => m.file)).toEqual(["1_a.sql", "2_b.sql", "10_c.sql", "20240101000000_x.sql"]);
    expect(compareMigrations({ version: "9", file: "9" }, { version: "10", file: "10" })).toBeLessThan(0);
  });

  it("plans pending / changed / remote-only", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "1_a.sql"), "select 1;");
    fs.writeFileSync(path.join(d, "2_b.sql"), "select 2;");
    fs.writeFileSync(path.join(d, "3_c.sql"), "select 3;");
    const local = readMigrations(d);
    const plan = planMigrations(local, [
      { version: "1", checksum: local[0]!.checksum, source: "levant" },
      { version: "2", checksum: "old", source: "levant" },
      { version: "0", checksum: null, source: "supabase" },
    ]);
    expect(plan.pending.map((m) => m.version)).toEqual(["3"]);
    expect(plan.changed.map((m) => m.version)).toEqual(["2"]);
    expect(plan.remoteOnly).toEqual(["0"]);
  });

  it("treats versions recorded by the Supabase CLI (no checksum) as applied", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "20230101000000_init.sql"), "create table t();");
    const plan = planMigrations(readMigrations(d), [{ version: "20230101000000", checksum: null, source: "supabase" }]);
    expect(plan.pending).toEqual([]);
    expect(plan.changed).toEqual([]);
  });

  it("wraps a migration and its history row in one transaction", () => {
    const m = { version: "1", name: "it's", file: "1_its.sql", sql: "create table a (id int);", checksum: "abc" };
    const b = migrationBatches(m, "me@x");
    expect(b).toHaveLength(1);
    expect(b[0]!.atomic).toBe(true);
    expect(b[0]!.sql.startsWith("begin;\ncreate table a (id int);")).toBe(true);
    expect(b[0]!.sql).toContain("'it''s'");
    expect(b[0]!.sql.trim().endsWith("commit;")).toBe(true);
  });

  it("does not wrap CONCURRENTLY / own transactions / enum additions", () => {
    expect(needsNoTransaction("create index concurrently i on t(x);")).toBe(true);
    expect(needsNoTransaction("begin;\ncreate table t();\ncommit;")).toBe(true);
    expect(needsNoTransaction("alter type mood add value 'meh';")).toBe(true);
    expect(needsNoTransaction("-- create index concurrently\ncreate table t();")).toBe(false);
    expect(needsNoTransaction("create table begin_log (x text default 'begin');")).toBe(false);
    const b = migrationBatches({ version: "1", name: "x", file: "1_x.sql", sql: "create index concurrently i on t(x);", checksum: "c" }, "me");
    expect(b[0]!.atomic).toBe(false);
    expect(b[0]!.sql).not.toMatch(/^begin;/);
  });

  it("splits large files on statement boundaries", () => {
    const stmts = Array.from({ length: 50 }, (_, i) => `insert into t values (${i}, '${"x".repeat(100)};y');`).join("\n");
    const b = migrationBatches({ version: "1", name: "big", file: "1_big.sql", sql: stmts, checksum: "c" }, "me", 1000);
    expect(b.length).toBeGreaterThan(5);
    expect(b.every((x) => x.sql.length <= 1100)).toBe(true);
    expect(b.at(-1)!.sql).toContain("levant_migrations");
    expect(b.slice(0, -1).map((x) => x.sql).join("\n")).toContain("(49,");
  });
});

describe("splitSql", () => {
  it("respects quotes, dollar bodies and comments", () => {
    const sql = `create function f() returns int language plpgsql as $$ begin return 1; end; $$;
-- a comment; with semicolon
insert into t values ('a;b', "c;d");
/* block; /* nested; */ */ select 1;
create function g() returns text as $body$ select 'x;' $body$ language sql;
\\echo hi
select 2`;
    const s = splitSql(sql);
    expect(s).toHaveLength(6);
    expect(s[0]).toContain("end; $$;");
    expect(s[1]).toContain("'a;b'");
    expect(s[3]).toContain("$body$ select 'x;' $body$");
    expect(s[4]).toBe("\\echo hi");
    expect(s[5]).toBe("select 2");
  });
  it("strips comments when asked", () => {
    expect(splitSql("select 1; -- x\n/* y */ select 2;", { keepComments: false }).map((x) => x.trim())).toEqual(["select 1;", "select 2;"]);
  });
});

describe("env files", () => {
  it("builds the variables apps expect", () => {
    const e = baseEnv("https://r.base.x", "anon");
    expect(e.NEXT_PUBLIC_SUPABASE_URL).toBe("https://r.base.x");
    expect(e.VITE_SUPABASE_ANON_KEY).toBe("anon");
    expect(e.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(baseEnv("u", "a", "svc").SUPABASE_SERVICE_ROLE_KEY).toBe("svc");
  });
  it("merges into an existing file (replace in place, keep the rest, append new)", () => {
    const cur = "# mine\nFOO=1\nexport SUPABASE_URL=old\nBAR=\"x y\"\n";
    const out = mergeEnvFile(cur, { SUPABASE_URL: "https://new", SUPABASE_ANON_KEY: "a b" }, "# LB");
    expect(out).toBe('# mine\nFOO=1\nSUPABASE_URL=https://new\nBAR="x y"\n\n# LB\nSUPABASE_ANON_KEY="a b"\n');
    expect(mergeEnvFile("", { A: "1" }, "# h")).toBe("# h\nA=1\n");
  });
  it("parses .env files and KEY=value args", () => {
    expect(parseEnvFile('A=1\n# c\nexport B="x\\ny"\nC=\'q\' \nD=v # comment\n')).toEqual({ A: "1", B: "x\ny", C: "q", D: "v" });
    expect(parseKeyValues(["STRIPE_KEY=sk=1", "EMPTY="])).toEqual({ STRIPE_KEY: "sk=1", EMPTY: "" });
    expect(() => parseKeyValues(["lower=1"])).toThrow(/Invalid secret name/);
    expect(() => parseKeyValues(["NOEQ"])).toThrow(/KEY=value/);
  });
});

describe("functions", () => {
  it("bundles a Supabase function folder with ../_shared imports", () => {
    const root = tmp();
    const fn = path.join(root, "hello");
    fs.mkdirSync(path.join(fn, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "_shared"));
    fs.writeFileSync(path.join(fn, "index.ts"), `import { cors } from "../_shared/cors.ts";\nimport { x } from "./lib/x.ts";\nDeno.serve(() => new Response(x, { headers: cors }));`);
    fs.writeFileSync(path.join(fn, "lib", "x.ts"), `import { cors } from "../../_shared/cors.ts";\nexport const x = "x" + Object.keys(cors).length;`);
    fs.writeFileSync(path.join(fn, "index.test.ts"), "test");
    fs.writeFileSync(path.join(root, "_shared", "cors.ts"), `export const cors = { "Access-Control-Allow-Origin": "*" };`);
    const b = bundleFunction(fn);
    expect(b.code).toContain(`from "./_shared/cors.ts"`);
    expect(b.files["lib/x.ts"]).toContain(`from "../_shared/cors.ts"`);
    expect(Object.keys(b.files).sort()).toEqual(["_shared/cors.ts", "lib/x.ts"]);
    expect(b.shared).toEqual(["cors.ts"]);
  });
  it("warns about per-function import maps and fails without index.ts", () => {
    const fn = tmp();
    fs.writeFileSync(path.join(fn, "index.ts"), "Deno.serve(() => new Response('ok'))");
    fs.writeFileSync(path.join(fn, "deno.json"), "{}");
    expect(bundleFunction(fn).warnings.join()).toMatch(/import maps/);
    expect(() => bundleFunction(tmp())).toThrow(/No index.ts/);
  });
  it("reads verify_jwt from supabase/config.toml", () => {
    const toml = `[api]\nport = 54321\n\n[functions.stripe-webhook]\nverify_jwt = false # webhooks\n\n[functions."hello"]\nverify_jwt = true\n[db]\nverify_jwt = false\n`;
    expect(functionsConfig(toml)).toEqual({ "stripe-webhook": { verifyJwt: false }, hello: { verifyJwt: true } });
  });
});

// ── command-level: `levant base db push` against a fake LevantDeploy API ─────────────────────────────────────────────
describe("levant base db push (fake API)", () => {
  const seen: string[] = [];
  const applied = new Set<string>();
  let server: http.Server;
  let url = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/v1/base/projects/abcdefghijklmnopqrst") {
          return res.end(JSON.stringify({ project: { ref: "abcdefghijklmnopqrst", name: "demo", status: "ACTIVE", apiUrl: "https://x", versions: {} } }));
        }
        if (req.url === "/api/v1/me") return res.end(JSON.stringify({ user: { email: "dev@example.com" } }));
        if (req.url?.endsWith("/sql")) {
          const sql = (JSON.parse(body) as { sql: string }).sql;
          seen.push(sql);
          if (sql.includes("from levant.levant_migrations")) return res.end(JSON.stringify({ rows: [...applied].map((v) => ({ version: v, checksum: null, source: "supabase" })), rowCount: applied.size }));
          const m = sql.match(/insert into levant\.levant_migrations[^']*values \('([^']+)'/);
          if (m) applied.add(m[1]!);
          return res.end(JSON.stringify({ rows: [], rowCount: 0 }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "nope" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("applies only pending files, in order, then is idempotent", async () => {
    const { Client } = await import("../src/api.js");
    const { baseDbPush } = await import("../src/commands/base.js");
    const d = tmp();
    fs.mkdirSync(path.join(d, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(d, "supabase", "migrations", "20240101000000_init.sql"), "create table a();");
    fs.writeFileSync(path.join(d, "supabase", "migrations", "20240102000000_more.sql"), "create table b();");
    applied.add("20240101000000"); // e.g. imported from supabase_migrations.schema_migrations
    const cwd = process.cwd();
    process.chdir(d);
    try {
      const c = new Client({ server: url, token: "ld_test" });
      await baseDbPush(c, undefined, { ref: "abcdefghijklmnopqrst", yes: true });
      expect(seen.some((s) => s.includes("create table b();"))).toBe(true);
      expect(seen.some((s) => s.includes("create table a();"))).toBe(false);
      expect(seen[0]).toContain("create table if not exists levant.levant_migrations");
      const before = seen.length;
      await baseDbPush(c, undefined, { ref: "abcdefghijklmnopqrst", yes: true });
      expect(seen.slice(before).some((s) => s.includes("create table b();"))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });
});
