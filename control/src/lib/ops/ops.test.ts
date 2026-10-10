import { describe, expect, it } from "vitest";
import { compareVersions, parseVersionDoc } from "./version";
import { isValidCron } from "./schedules";
import { pgArgs, BACKUP_NAME_RE } from "./backup";
import { dnsRecords } from "./platform";

describe("ops/version", () => {
  it("compares versions", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0-rc.2", "1.2.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
  });
  it("parses version documents", () => {
    expect(parseVersionDoc('{"version":"1.3.0","notes":"x","url":"https://e"}')).toEqual({ version: "1.3.0", notes: "x", url: "https://e" });
    expect(parseVersionDoc('{"tag_name":"v2.0.0","body":"notes","html_url":"https://gh"}', "application/json")).toEqual({ version: "v2.0.0", notes: "notes", url: "https://gh" });
    expect(parseVersionDoc("1.4.2\nignored")).toEqual({ version: "1.4.2", notes: null, url: null });
    expect(parseVersionDoc("<html>nope</html>")).toBeNull();
    expect(parseVersionDoc("{bad json")).toBeNull();
    expect(parseVersionDoc("")).toBeNull();
  });
});

describe("ops/schedules", () => {
  it("validates cron expressions", () => {
    for (const ok of ["23 3 * * *", "*/15 * * * *", "0 0 1 1 *", "7 */6 * * 1-5", "0,30 9-17 * * 0"]) expect(isValidCron(ok)).toBe(true);
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "a b c d e", "5-1 * * * *"]) expect(isValidCron(bad)).toBe(false);
  });
});

describe("ops/backup", () => {
  it("builds pg_dump args without leaking the password", () => {
    const { args, password } = pgArgs("postgresql://levant:p%40ss@postgres:5432/levantdeploy?schema=public");
    expect(args).toEqual(["-h", "postgres", "-p", "5432", "-U", "levant", "-d", "levantdeploy"]);
    expect(password).toBe("p@ss");
    expect(pgArgs("postgresql://u:x@db/app?schema=tenant").args).toContain("tenant");
  });
  it("only accepts generated backup names", () => {
    expect(BACKUP_NAME_RE.test("levantdeploy-20261009-120000.dump")).toBe(true);
    expect(BACKUP_NAME_RE.test("../etc/passwd")).toBe(false);
    expect(BACKUP_NAME_RE.test("levantdeploy-20261009-120000.dump.partial")).toBe(false);
  });
});

describe("ops/platform", () => {
  it("derives DNS records", () => {
    const rows = dnsRecords({ platformDomain: "example.com", dashboardHost: "deploy.example.com:443", serverIps: { ipv4: "203.0.113.10", ipv6: "2001:db8::1", detectedAt: null, fromEnv: [] } });
    expect(rows).toEqual([
      { type: "A", name: "deploy.example.com", value: "203.0.113.10", purpose: "Dashboard + API" },
      { type: "AAAA", name: "deploy.example.com", value: "2001:db8::1", purpose: "Dashboard + API" },
      { type: "A", name: "*.example.com", value: "203.0.113.10", purpose: "Deployment URLs and previews" },
      { type: "AAAA", name: "*.example.com", value: "2001:db8::1", purpose: "Deployment URLs and previews" },
    ]);
    expect(dnsRecords({ platformDomain: "e.com", dashboardHost: "d.e.com", serverIps: { ipv4: null, ipv6: null, detectedAt: null, fromEnv: [] } })[0].value).toBe("<server IPv4>");
  });
});
