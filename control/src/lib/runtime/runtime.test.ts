import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cronMatches, describeCron, isValidCron, nextRun, parseCron } from "./cron-expr";
import { healthConfig, statusAlive } from "./settings";
import { buildCaddyConfig, buildHostMap, type ProxyState } from "@/lib/proxy/config";
import { deriveRoutes } from "@/lib/proxy/state";
import { isApex, normalizeHostname, validateHostname, validateSubdomainLabel, wwwCounterpart } from "@/lib/domains/validate";
import { createResolverLookup } from "@/lib/domains/dns";
import { checkDns, dnsInstructions, nextCheckDelayMs } from "@/lib/domains/verify";
import { aggregateAccess, cpuPercent, percentile } from "./metrics";
import { rewriteCompose } from "./compose";
import { detectLevel, filterLogLines, sourcesOf } from "./log-filter";
import { sortableTs, splitTimestamp } from "./log-follower";
import { demuxBuffer } from "./containers";
import { connectionEnvNames, ENGINES } from "./db-engines";
import { startFakeDns } from "../../../tests/runtime/fake-dns";

process.env.PLATFORM_DOMAIN = "apps.test";

describe("cron expressions", () => {
  it("parses and validates", () => {
    expect(isValidCron("*/5 * * * *")).toBeNull();
    expect(isValidCron("@daily")).toBeNull();
    expect(isValidCron("0 9 * * mon-fri")).toBeNull();
    expect(isValidCron("61 * * * *")).toMatch(/range/);
    expect(isValidCron("* * *")).toMatch(/5 fields/);
    expect([...parseCron("1-10/3 * * * *").minute.set]).toEqual([1, 4, 7, 10]);
    expect(parseCron("0 0 * * 7").dow.set.has(0)).toBe(true);
  });
  it("computes next runs (UTC and timezones)", () => {
    const from = Date.UTC(2026, 0, 1, 10, 7, 30);
    expect(nextRun("*/15 * * * *", from)!.toISOString()).toBe("2026-01-01T10:15:00.000Z");
    expect(nextRun("0 0 * * *", from)!.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(nextRun("30 9 * * *", from, "Asia/Beirut")!.toISOString()).toBe("2026-01-02T07:30:00.000Z"); // UTC+2 in winter
    expect(nextRun("0 0 1 * *", from)!.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(nextRun("0 0 29 2 *", from)!.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  it("vixie dom/dow semantics + descriptions", () => {
    const c = parseCron("0 0 13 * fri");
    expect(cronMatches(c, Date.UTC(2026, 1, 13), "UTC")).toBe(true); // 13th
    expect(cronMatches(c, Date.UTC(2026, 1, 6), "UTC")).toBe(true); // a friday
    expect(cronMatches(c, Date.UTC(2026, 1, 7), "UTC")).toBe(false);
    expect(describeCron("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeCron("30 4 * * *")).toBe("every day at 04:30");
  });
});

describe("health config", () => {
  it("defaults and policies", () => {
    expect(statusAlive(404, "lt500")).toBe(true);
    expect(statusAlive(503, "lt500")).toBe(false);
    expect(statusAlive(404, "2xx3xx")).toBe(false);
    expect(statusAlive(302, "2xx3xx")).toBe(true);
    expect(statusAlive(0, "any")).toBe(false);
    expect(healthConfig({ kind: "WEB", healthcheckPath: "health", runtimeSettings: {} })).toMatchObject({ type: "http", path: "/health", timeoutMs: 120_000 });
    expect(healthConfig({ kind: "WEB", healthcheckPath: null, runtimeSettings: {} }).type).toBe("tcp");
    expect(healthConfig({ kind: "WORKER", healthcheckPath: "/", runtimeSettings: { workerStableSeconds: 5 } })).toMatchObject({ type: "running", stableMs: 5000 });
    expect(healthConfig({ kind: "WEB", healthcheckPath: "/", runtimeSettings: { healthcheck: { type: "tcp", timeoutSeconds: 30 } } })).toMatchObject({ type: "tcp", timeoutMs: 30_000 });
  });
});

const dep = (o: Record<string, unknown>) => ({
  id: "d1",
  projectId: "p1",
  url: "shop-aaaaaaaaa.apps.test",
  branch: "main",
  target: "PRODUCTION" as const,
  status: "READY" as const,
  isCurrentProduction: false,
  containerIds: [{ id: "c1", name: "n", replica: 1, port: 3000, alias: "ld-aaaaaaaaa-1" }],
  stoppedAt: null,
  readyAt: new Date(1000),
  createdAt: new Date(1000),
  ...o,
});

describe("route derivation + caddy config", () => {
  const projects = [{ id: "p1", slug: "shop" }];
  const domains = [
    { hostname: "shop.apps.test", projectId: "p1", status: "ACTIVE" as const, redirectTo: null, redirectStatus: null, gitBranch: null },
    { hostname: "example.com", projectId: "p1", status: "ACTIVE" as const, redirectTo: null, redirectStatus: null, gitBranch: null },
    { hostname: "www.example.com", projectId: "p1", status: "ACTIVE" as const, redirectTo: "example.com", redirectStatus: 308, gitBranch: null },
    { hostname: "pending.example.com", projectId: "p1", status: "PENDING" as const, redirectTo: null, redirectStatus: null, gitBranch: null },
    { hostname: "staging.example.com", projectId: "p1", status: "ACTIVE" as const, redirectTo: null, redirectStatus: null, gitBranch: "dev" },
  ];
  const deployments = [
    dep({ id: "prod", isCurrentProduction: true, containerIds: [{ id: "c1", replica: 1, port: 3000, alias: "ld-p-1" }, { id: "c2", replica: 2, port: 3000, alias: "ld-p-2" }] }),
    dep({ id: "old", url: "shop-old.apps.test", status: "SUPERSEDED", stoppedAt: new Date(), readyAt: new Date(10) }),
    dep({ id: "dev1", url: "shop-dev1.apps.test", branch: "dev", target: "PREVIEW", readyAt: new Date(2000), containerIds: [{ id: "c3", replica: 1, port: 3000, alias: "ld-d1-1" }] }),
    dep({ id: "dev2", url: "shop-dev2.apps.test", branch: "dev", target: "PREVIEW", readyAt: new Date(3000), containerIds: [{ id: "c4", replica: 1, port: 3000, alias: "ld-d2-1" }] }),
  ];
  const { sites, redirects } = deriveRoutes(projects, domains, deployments as never);
  it("routes production domains, branch aliases, deployment URLs", () => {
    const prod = sites.find((s) => s.deploymentId === "prod")!;
    expect(prod.hosts).toEqual(expect.arrayContaining(["shop.apps.test", "example.com", "shop-git-main.apps.test", "shop-aaaaaaaaa.apps.test"]));
    expect(prod.hosts).not.toContain("pending.example.com");
    expect(prod.upstreams).toEqual(["ld-p-1:3000", "ld-p-2:3000"]);
    const dev2 = sites.find((s) => s.deploymentId === "dev2")!;
    expect(dev2.hosts).toEqual(expect.arrayContaining(["shop-git-dev.apps.test", "staging.example.com", "shop-dev2.apps.test"]));
    expect(sites.find((s) => s.deploymentId === "dev1")!.hosts).toEqual(["shop-dev1.apps.test"]);
    expect(sites.find((s) => s.deploymentId === "old")).toBeUndefined(); // stopped
    expect(redirects).toEqual([{ host: "www.example.com", to: "example.com", status: 308, projectId: "p1" }]);
  });
  it("skips worker projects", () => {
    expect(deriveRoutes([{ id: "p1", slug: "shop", kind: "WORKER" }], domains, deployments as never).sites).toHaveLength(0);
  });
  it("builds an idempotent caddy config", () => {
    const state: ProxyState = {
      dashboardHost: "deploy.example.org:3000",
      controlUpstream: "control:3000",
      scheme: "https",
      tls: "acme",
      acmeEmail: "ops@example.org",
      logDir: "/var/log/caddy",
      adminListen: "0.0.0.0:2019",
      adminOrigins: ["caddy:2019"],
      sites,
      redirects,
    };
    const a = JSON.stringify(buildCaddyConfig(state));
    expect(JSON.stringify(buildCaddyConfig(state))).toBe(a);
    const cfg = buildCaddyConfig(state) as { apps: { http: { servers: Record<string, { routes: unknown[] }> }; tls: { automation: { on_demand: { permission: { endpoint: string } } } } } };
    expect(cfg.apps.tls.automation.on_demand.permission.endpoint).toBe("http://control:3000/api/internal/tls-ask");
    expect(a).toContain('"host":["deploy.example.org"]');
    expect(a).toContain('"Location":["{http.request.scheme}://example.com{http.request.uri}"]');
    expect(a).toContain("/api/internal/pages/host?host={http.request.host}");
    // https mode: :80 only redirects
    expect(JSON.stringify(cfg.apps.http.servers.levant_http!.routes)).toContain('"status_code":308');
    const http = buildCaddyConfig({ ...state, scheme: "http", tls: "internal" }) as typeof cfg;
    expect(JSON.stringify(http.apps.http.servers.levant_http!.routes)).toContain("reverse_proxy");
    expect(JSON.stringify(http)).toContain('"module":"internal"');
    expect(buildHostMap(state)["example.com"]).toEqual({ projectId: "p1", deploymentId: "prod" });
  });
});

describe("domain validation", () => {
  const o = { platformDomain: "apps.test", dashboardHost: "deploy.example.org" };
  it("normalises", () => {
    expect(normalizeHostname(" https://WWW.Example.com/path?x ")).toBe("www.example.com");
    expect(normalizeHostname("bücher.de")).toBe("xn--bcher-kva.de");
    expect(normalizeHostname("example.com.")).toBe("example.com");
  });
  it("rejects bad / reserved hosts", () => {
    expect(validateHostname("example.com", o)).toBeNull();
    expect(validateHostname("localhost", o)).toMatch(/full domain/);
    expect(validateHostname("1.2.3.4", o)).toMatch(/IP/);
    expect(validateHostname("*.com", o)).toMatch(/domain you own/);
    expect(validateHostname("foo.apps.test", o)).toMatch(/managed by LevantDeploy/);
    expect(validateHostname("deploy.example.org", o)).toMatch(/dashboard/);
    expect(validateHostname("my-app.local", o)).toMatch(/\.local/);
    expect(validateHostname("-bad.example.com", o)).toMatch(/dash/);
    expect(validateSubdomainLabel("shop")).toBeNull();
    expect(validateSubdomainLabel("a-git-b")).toMatch(/reserved/);
    expect(validateSubdomainLabel("www")).toMatch(/reserved/);
    expect(validateSubdomainLabel("Bad_")).not.toBeNull();
    expect(wwwCounterpart("example.com")).toBe("www.example.com");
    expect(wwwCounterpart("www.example.com")).toBe("example.com");
    expect(wwwCounterpart("app.example.com")).toBeNull();
    expect(isApex("example.com")).toBe(true);
  });
  it("dns instructions + cadence", () => {
    process.env.SERVER_IPS = "203.0.113.10";
    const recs = dnsInstructions({ hostname: "app.example.com", verifyToken: "tok" });
    expect(recs[0]).toMatchObject({ type: "CNAME", name: "app", value: "cname.apps.test" });
    expect(recs.at(-1)).toMatchObject({ type: "TXT", name: "_levant-verify.app", value: "tok" });
    const created = new Date(0);
    expect(nextCheckDelayMs(created, new Date(30 * 60_000))).toBe(60_000);
    expect(nextCheckDelayMs(created, new Date(5 * 3600_000))).toBe(600_000);
    expect(nextCheckDelayMs(created, new Date(50 * 3600_000))).toBe(86_400_000);
  });
});

describe("domain verification against a fake DNS server", () => {
  let srv: Awaited<ReturnType<typeof startFakeDns>>;
  beforeAll(async () => {
    srv = await startFakeDns({});
  });
  afterAll(async () => {
    await srv.close();
  });
  it("needs routing + ownership records", async () => {
    const lookup = createResolverLookup([`127.0.0.1:${srv.port}`], 1000);
    const ips = ["203.0.113.10"];
    srv.set({});
    let r = await checkDns("example.com", "tok-1", lookup, ips);
    expect(r).toMatchObject({ ok: false, routing: false, ownership: false, reason: "No A/AAAA or CNAME record found" });
    srv.set({ "example.com": { A: ["198.51.100.1"] } });
    r = await checkDns("example.com", "tok-1", lookup, ips);
    expect(r.reason).toMatch(/Points to 198.51.100.1/);
    srv.set({ "example.com": { A: ["203.0.113.10"] } });
    r = await checkDns("example.com", "tok-1", lookup, ips);
    expect(r).toMatchObject({ routing: true, ownership: false });
    expect(r.reason).toMatch(/TXT record/);
    srv.set({ "example.com": { A: ["203.0.113.10"] }, "_levant-verify.example.com": { TXT: ["other", "tok-1"] } });
    r = await checkDns("example.com", "tok-1", lookup, ips);
    expect(r).toMatchObject({ ok: true, routing: true, ownership: true, a: ["203.0.113.10"] });
    // CNAME to the platform target (no SERVER_IPS match needed)
    srv.set({ "www.example.com": { CNAME: "cname.apps.test" }, "cname.apps.test": { A: ["192.0.2.1"] }, "_levant-verify.www.example.com": { TXT: ["tok-2"] } });
    r = await checkDns("www.example.com", "tok-2", lookup, ips);
    expect(r).toMatchObject({ ok: true, cname: ["cname.apps.test"] });
  });
});

describe("metrics helpers", () => {
  it("cpu % and percentiles", () => {
    expect(
      cpuPercent({
        cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 20_000_000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
        memory_stats: {},
      }),
    ).toBeCloseTo(40);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });
  it("aggregates access log lines per deployment and minute", () => {
    const map = { "shop.apps.test": { projectId: "p1", deploymentId: "d1" } };
    const ts = Date.UTC(2026, 0, 1, 12, 0, 10) / 1000;
    const lines = [
      JSON.stringify({ ts, status: 200, duration: 0.01, request: { host: "shop.apps.test" } }),
      JSON.stringify({ ts, status: 404, duration: 0.02, request: { host: "shop.apps.test:443" } }),
      JSON.stringify({ ts: ts + 1, status: 502, duration: 0.5, request: { host: "SHOP.apps.test" } }),
      JSON.stringify({ ts, status: 200, duration: 0.01, request: { host: "unknown.apps.test" } }),
      "not json",
    ];
    const acc = aggregateAccess(lines, map);
    expect(acc.size).toBe(1);
    const a = [...acc.values()][0]!;
    expect(a).toMatchObject({ count: 3, e4: 1, e5: 1, bucket: Date.UTC(2026, 0, 1, 12, 0) });
  });
});

describe("compose rewrite", () => {
  it("drops host ports, joins levant_net, stable volumes, picks the public service", () => {
    const cfg = {
      name: "x",
      services: {
        web: { image: "img:web", ports: [{ target: 3000, published: "8080" }], environment: { OWN: "1" }, container_name: "fixed" },
        cache: { image: "redis:7", volumes: [{ type: "volume", source: "data", target: "/data" }] },
      },
      volumes: { data: { name: "x_data" } },
    };
    const r = rewriteCompose(cfg as never, {
      shortId: "abc123def",
      projectId: "p1",
      deploymentId: "d1",
      teamId: "t1",
      network: "levant_net",
      env: { LEVANT: "1", PORT: "9999", HOST: "0.0.0.0" },
      meta: { file: "" },
      defaultPort: 3000,
    });
    expect(r.publicService).toBe("web");
    expect(r.publicPort).toBe(3000);
    const web = r.config.services.web!;
    expect(web.ports).toBeUndefined();
    expect(web.container_name).toBeUndefined();
    expect(web.networks).toMatchObject({ levant_net: { aliases: ["ld-abc123def-web"] } });
    expect(web.environment).toMatchObject({ LEVANT: "1", OWN: "1", PORT: "3000" });
    expect(r.config.services.cache!.environment!.PORT).toBeUndefined();
    expect(r.config.volumes!.data).toMatchObject({ name: "levant_vol_p1_data" });
    expect(r.config.networks!.levant_net).toEqual({ name: "levant_net", external: true });
  });
});

describe("logs", () => {
  const L = (line: string, ts = 1) => ({ id: String(ts), ts, line });
  it("level heuristics + filters", () => {
    expect(detectLevel("[r1] Error: boom")).toBe("error");
    expect(detectLevel('[r1] {"level":"warn","msg":"x"}')).toBe("warn");
    expect(detectLevel("[web] DEBUG cache miss")).toBe("debug");
    expect(detectLevel("[r2] GET / 200")).toBe("info");
    const lines = [L("[r1] GET /", 1), L("[r2] WARN slow", 2), L("[r1] ERROR failed", 3), L("[r2] debug x", 4)];
    expect(filterLogLines(lines, { level: "warn" }).map((l) => l.ts)).toEqual([2, 3]);
    expect(filterLogLines(lines, { replica: "r2" }).map((l) => l.ts)).toEqual([2, 4]);
    expect(filterLogLines(lines, { q: "get", since: 1, until: 3 }).map((l) => l.ts)).toEqual([1]);
    expect(sourcesOf(lines)).toEqual(["r1", "r2"]);
  });
  it("docker timestamps + demux", () => {
    expect(splitTimestamp("2026-01-01T00:00:00.5Z hello world")).toEqual(["2026-01-01T00:00:00.5Z", "hello world"]);
    const a = sortableTs("2026-01-01T00:00:00.5Z")!;
    const b = sortableTs("2026-01-01T00:00:00.123456789Z")!;
    expect(a > b).toBe(true);
    const frame = (t: number, s: string) => Buffer.concat([Buffer.from([t, 0, 0, 0, 0, 0, 0, s.length]), Buffer.from(s)]);
    expect(demuxBuffer(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]))).toBe("out\nerr\n");
    expect(demuxBuffer(Buffer.from("plain tty output"))).toBe("plain tty output");
  });
});

describe("database engines", () => {
  it("connection strings + env names", () => {
    const c = { user: "app", password: "p@ss", database: "main" };
    expect(ENGINES.POSTGRES.url(c, "ld-db-x", 5432)).toBe("postgresql://app:p%40ss@ld-db-x:5432/main");
    expect(ENGINES.REDIS.url(c, "h", 6379)).toBe("redis://default:p%40ss@h:6379");
    expect(ENGINES.MONGO.url(c, "h", 27017)).toContain("authSource=admin");
    expect(connectionEnvNames("POSTGRES", "main", true)).toEqual(["DATABASE_URL", "POSTGRES_URL"]);
    expect(connectionEnvNames("POSTGRES", "analytics-db", false)).toEqual(["ANALYTICS_DB_URL"]);
  });
});

describe("deployment protection", () => {
  it("signs and verifies the password cookie", async () => {
    const { signAuthCookie, verifyAuthCookie, safeNext, readCookie } = await import("@/lib/proxy/protection");
    const c = signAuthCookie("p1", "$2a$10$abcdefghijklmnopqrstuv");
    expect(verifyAuthCookie(c, "p1", "$2a$10$abcdefghijklmnopqrstuv")).toBe(true);
    expect(verifyAuthCookie(c, "p2", "$2a$10$abcdefghijklmnopqrstuv")).toBe(false);
    expect(verifyAuthCookie(c, "p1", "$2a$10$OTHERHASHxxxxxxxxxxxxx")).toBe(false); // password changed
    expect(verifyAuthCookie(c, "p1", "$2a$10$abcdefghijklmnopqrstuv", Date.now() + 8 * 86400_000)).toBe(false); // expired
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("/a?b=1")).toBe("/a?b=1");
    expect(readCookie("x=1; __levant_auth=abc.d", "__levant_auth")).toBe("abc.d");
  });
  it("protects preview hosts (scope previews) or everything (scope all)", () => {
    const hash = "$2a$10$abcdefghijklmnopqrstuv";
    const projects = [{ id: "p1", slug: "shop", protection: { mode: "basic", scope: "previews", username: "u", passwordHash: hash } }];
    const domains = [{ hostname: "shop.apps.test", projectId: "p1", status: "ACTIVE" as const, redirectTo: null, redirectStatus: null, gitBranch: null }];
    const deps = [
      dep({ id: "prod", isCurrentProduction: true }),
      dep({ id: "pr", url: "shop-pr.apps.test", branch: "feat", target: "PREVIEW", containerIds: [{ id: "c9", replica: 1, port: 3000, alias: "ld-pr-1" }] }),
    ];
    const { sites } = deriveRoutes(projects, domains, deps as never);
    const prod = sites.find((s) => s.deploymentId === "prod")!;
    expect(prod.protectedHosts).toEqual(expect.arrayContaining(["shop-aaaaaaaaa.apps.test", "shop-git-main.apps.test"]));
    expect(prod.protectedHosts).not.toContain("shop.apps.test");
    expect(sites.find((s) => s.deploymentId === "pr")!.protectedHosts).toEqual(expect.arrayContaining(["shop-pr.apps.test", "shop-git-feat.apps.test"]));
    const all = deriveRoutes([{ ...projects[0]!, protection: { ...projects[0]!.protection, scope: "all" } }], domains, deps as never).sites;
    expect(all.find((s) => s.deploymentId === "prod")!.protectedHosts).toContain("shop.apps.test");
    const none = deriveRoutes([{ id: "p1", slug: "shop", protection: { mode: "password", scope: "all" } }], domains, deps as never).sites; // no hash → off
    expect(none[0]!.protection).toBeUndefined();

    const base: ProxyState = { dashboardHost: "d.test", controlUpstream: "control:3000", scheme: "http", tls: "off", logDir: "/l", adminListen: ":2019", adminOrigins: [], sites, redirects: [] };
    const basic = JSON.stringify(buildCaddyConfig(base));
    expect(basic).toContain('"handler":"authentication"');
    expect(basic).toContain(Buffer.from(hash).toString("base64"));
    const pw = JSON.stringify(
      buildCaddyConfig({ ...base, sites: sites.map((s) => ({ ...s, protection: { mode: "password" as const, passwordHash: hash } })) }),
    );
    expect(pw).toContain("/api/internal/protection/check");
    expect(pw).toContain('"path":["/__levant/auth"]');
    expect(pw).toContain('"status_code":[2]');
  });
});

describe("wildcard domains", () => {
  const o = { platformDomain: "apps.test", dashboardHost: "deploy.example.org" };
  it("validates", async () => {
    const { isWildcard, coveringWildcard } = await import("@/lib/domains/validate");
    expect(normalizeHostname("*.Example.COM")).toBe("*.example.com");
    expect(normalizeHostname("*.bücher.de")).toBe("*.xn--bcher-kva.de");
    expect(validateHostname("*.example.com", o)).toBeNull();
    expect(validateHostname("*.shop.example.com", o)).toBeNull();
    expect(validateHostname("*.com", o)).toMatch(/domain you own/);
    expect(validateHostname("*.co.uk", o)).toMatch(/domain you own/);
    expect(validateHostname("*.*.example.com", o)).toMatch(/one leading/);
    expect(validateHostname("a.*.example.com", o)).toMatch(/first label/);
    expect(validateHostname("*.apps.test", o)).toMatch(/managed by LevantDeploy/);
    expect(validateHostname("*.x.apps.test", o)).toMatch(/managed by LevantDeploy/);
    expect(isWildcard("*.example.com")).toBe(true);
    expect(coveringWildcard("a.example.com")).toBe("*.example.com");
    expect(coveringWildcard("example.com")).toBeNull();
    expect(wwwCounterpart("*.example.com")).toBeNull();
  });
  it("dns instructions use the base for TXT", () => {
    process.env.SERVER_IPS = "203.0.113.10";
    const recs = dnsInstructions({ hostname: "*.example.com", verifyToken: "tok" });
    expect(recs[0]).toMatchObject({ type: "CNAME", name: "*", value: "cname.apps.test" });
    expect(recs.at(-1)).toMatchObject({ type: "TXT", name: "_levant-verify", value: "tok" });
    const sub = dnsInstructions({ hostname: "*.shop.example.com", verifyToken: "t" });
    expect(sub[0]!.name).toBe("*.shop");
    expect(sub.at(-1)!.name).toBe("_levant-verify.shop");
  });
  it("verifies against a fake DNS wildcard record", async () => {
    const srv = await startFakeDns({ "*.example.test": { A: ["203.0.113.10"] }, "_levant-verify.example.test": { TXT: ["wtok"] } });
    try {
      const lookup = createResolverLookup([`127.0.0.1:${srv.port}`], 1000);
      expect(await checkDns("*.example.test", "wtok", lookup, ["203.0.113.10"])).toMatchObject({ ok: true, routing: true, ownership: true });
      srv.set({ "_levant-verify.example.test": { TXT: ["wtok"] } });
      expect((await checkDns("*.example.test", "wtok", lookup, ["203.0.113.10"])).reason).toMatch(/No wildcard record/);
    } finally {
      await srv.close();
    }
  });
  it("routes exact hosts before wildcard hosts", () => {
    const domains = [
      { hostname: "*.example.test", projectId: "p1", status: "ACTIVE" as const, redirectTo: null, redirectStatus: null, gitBranch: null },
      { hostname: "special.example.test", projectId: "p2", status: "ACTIVE" as const, redirectTo: null, redirectStatus: null, gitBranch: null },
    ];
    const deps = [
      dep({ id: "a", isCurrentProduction: true }),
      dep({ id: "b", projectId: "p2", url: "other-x.apps.test", isCurrentProduction: true, containerIds: [{ id: "c2", replica: 1, port: 80, alias: "ld-b-1" }] }),
    ];
    const { sites } = deriveRoutes([{ id: "p1", slug: "shop" }, { id: "p2", slug: "other" }], domains, deps as never);
    const cfg = buildCaddyConfig({ dashboardHost: "d.test", controlUpstream: "c:3000", scheme: "http", tls: "off", logDir: "/l", adminListen: ":2019", adminOrigins: [], sites, redirects: [] });
    const inner = (cfg as any).apps.http.servers.levant_http.routes[0].handle[0].routes as Array<{ match?: Array<{ host?: string[] }> }>;
    const idx = (h: string) => inner.findIndex((r) => r.match?.[0]?.host?.includes(h));
    expect(idx("*.example.test")).toBeGreaterThan(idx("special.example.test"));
    expect(idx("*.example.test")).toBeGreaterThan(idx("shop.apps.test") === -1 ? -1 : idx("shop-aaaaaaaaa.apps.test"));
    expect(buildHostMap({ sites, redirects: [] } as never)["*.example.test"]).toEqual({ projectId: "p1", deploymentId: "a" });
    const acc = aggregateAccess([JSON.stringify({ ts: 1, status: 200, duration: 0.01, request: { host: "store1.example.test" } })], buildHostMap({ sites, redirects: [] } as never));
    expect([...acc.values()][0]).toMatchObject({ projectId: "p1", deploymentId: "a" });
  });
});
