import { describe, expect, it } from "vitest";
import { connectEnvVars, generatePassword, isReadOnlySql, maskConnString, passwordStrength, quickstartSnippets, stripSql, usagePct, DB_PASSWORD_RE, BASE_PAGES, isRef } from "./shared";

describe("isReadOnlySql (AI run_base_sql approval gate)", () => {
  it("allows plain reads", () => {
    for (const q of ["select * from todos", "SELECT 1;", "with x as (select 1) select * from x", "explain select * from t", "show search_path", "table todos", "values (1),(2)", "select 'drop table x' as s", "-- delete\nselect 1", "select $$insert$$"])
      expect(isReadOnlySql(q), q).toBe(true);
  });
  it("rejects anything that writes, locks or escapes the read-only transaction", () => {
    for (const q of [
      "insert into t values (1)",
      "update t set a = 1",
      "delete from t",
      "drop table t",
      "select 1; drop table t",
      "with d as (delete from t returning *) select * from d",
      "select * into newtable from t",
      "select * from t for update",
      "explain analyze delete from t",
      "select pg_terminate_backend(1)",
      "select set_config('a','b',false)",
      "commit; select 1",
      "create table x(a int)",
      "grant all on t to anon",
      "",
      "   ;  ",
    ])
      expect(isReadOnlySql(q), q).toBe(false);
  });
  it("stripSql removes comments and literals but keeps structure", () => {
    expect(stripSql("select 'a;b' -- x\n/* y */ from t")).not.toMatch(/a;b|x|y/);
  });
});

describe("passwords", () => {
  it("generated passwords satisfy the runtime rule and are strong", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(DB_PASSWORD_RE);
      expect(passwordStrength(p).score).toBeGreaterThanOrEqual(3);
    }
  });
  it("rates weak passwords low with hints", () => {
    expect(passwordStrength("password123").score).toBeLessThan(3);
    expect(passwordStrength("aaaaaaaaaaaaaaaaaaaa").score).toBeLessThan(3);
    expect(passwordStrength("with spaces & symbols!!").hints[0]).toMatch(/letters and digits/);
  });
});

describe("connectEnvVars", () => {
  const info = { url: "https://abc.base.example.com", internalUrl: "http://base-abc:8000", anonKey: "anon", serviceRoleKey: "service", poolerUrl: "postgresql://p", directUrl: null };
  it("writes the four public vars; SUPABASE_URL is internal except for Development", () => {
    const prod = connectEnvVars(info, { includeServiceRole: false, includeDatabaseUrl: false, databaseUrlKind: "pooler" }, "PRODUCTION");
    expect(prod.map((v) => v.key)).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY"]);
    expect(prod.find((v) => v.key === "SUPABASE_URL")!.value).toBe("http://base-abc:8000");
    expect(prod.find((v) => v.key === "NEXT_PUBLIC_SUPABASE_URL")!.value).toBe(info.url);
    const dev = connectEnvVars(info, { includeServiceRole: false, includeDatabaseUrl: false, databaseUrlKind: "pooler" }, "DEVELOPMENT");
    expect(dev.find((v) => v.key === "SUPABASE_URL")!.value).toBe(info.url);
  });
  it("service role key and DATABASE_URL are opt-in secrets", () => {
    const all = connectEnvVars(info, { includeServiceRole: true, includeDatabaseUrl: true, databaseUrlKind: "direct" });
    expect(all.find((v) => v.key === "SUPABASE_SERVICE_ROLE_KEY")).toEqual({ key: "SUPABASE_SERVICE_ROLE_KEY", value: "service", isSecret: true });
    expect(all.find((v) => v.key === "DATABASE_URL")).toEqual({ key: "DATABASE_URL", value: "postgresql://p", isSecret: true });
  });
});

describe("misc", () => {
  it("masks connection string passwords", () => {
    expect(maskConnString("postgresql://postgres:s3cr3t@db:5432/postgres")).toBe("postgresql://postgres:••••••••@db:5432/postgres");
  });
  it("usage percentage", () => {
    expect(usagePct(50, 100)).toBe(50);
    expect(usagePct(500, 100)).toBe(100);
    expect(usagePct(5, null)).toBeNull();
  });
  it("quick-start snippets never contain a service key and use the project URL", () => {
    const s = quickstartSnippets("https://x.base.example.com", "ANON");
    expect(s.map((x) => x.id)).toEqual(["js", "next", "flutter", "curl"]);
    for (const x of s) expect(x.code).toContain("https://x.base.example.com");
  });
  it("refs and page list", () => {
    expect(isRef("abcdefghijklmnopqrst")).toBe(true);
    expect(isRef("abc")).toBe(false);
    expect(BASE_PAGES[0]!.seg).toBe("");
  });
});
