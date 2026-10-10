import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ||= "postgresql://localhost/test";
process.env.PLATFORM_DOMAIN = "levant.test";
process.env.PLATFORM_SCHEME = "https";
delete process.env.BASE_DOMAIN;

import { decodeJwt, decodeProtectedHeader } from "jose";
import { apiHost, generateRef, isRef, parseBaseHost, projectUrl, studioHost, internalUrl } from "./config";
import { generateSecrets, signApiKey, verifyApiKey, DB_PASSWORD_RE, JWT_ISSUER } from "./secrets";
import { BASE_PLAN_DEFAULTS, MIN_STACK_MEMORY_MB, mergeLimits, serviceResources } from "./limits";
import { buildEnv, publicOverride, renderStack, serializeEnv, type RenderInput } from "./render";
import { parsePortRange, writeFunctionDir } from "./service";
import { ownershipFixSql, PLATFORM_SCHEMAS, markOwnershipFixed } from "./ownership";
import { poolerEnabled } from "./stack";
import { applySettingsPatch, baseSettingsPatchSchema, DEFAULT_SETTINGS, readSettings, publicSettings } from "./settings";
import { DEFAULT_VERSIONS, imageRef, resolveVersions } from "./versions";
import { aggregateBaseAccess } from "./usage";
import { parseStudioCookie, signStudioCookie } from "./studio";
import { parseCsv, parseLastCsv } from "./service";
import { renderBasePage, kindForStatus } from "./pages";
import { buildBaseRoutes, baseErrorRoute, type BaseRoute } from "@/lib/proxy/base";
import { buildCaddyConfig, type ProxyState } from "@/lib/proxy/config";
import { canTransition } from "./events";
import { decideEnforcement } from "./enforce";

const repo = path.resolve(__dirname, "../../../..");

describe("refs + hosts", () => {
  it("generates 20-letter refs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = generateRef();
      expect(isRef(r)).toBe(true);
      seen.add(r);
    }
    expect(seen.size).toBe(200);
  });
  it("builds and parses base hosts (BASE_DOMAIN defaults to base.{PLATFORM_DOMAIN})", () => {
    const ref = "abcdefghijklmnopqrst";
    expect(apiHost(ref)).toBe(`${ref}.base.levant.test`);
    expect(studioHost(ref)).toBe(`studio-${ref}.base.levant.test`);
    expect(projectUrl(ref)).toBe(`https://${ref}.base.levant.test`);
    expect(internalUrl(ref)).toBe(`http://base-${ref}:8000`);
    expect(parseBaseHost(`${ref}.base.levant.test`)).toEqual({ kind: "api", ref });
    expect(parseBaseHost(`STUDIO-${ref}.base.levant.test:443`)).toEqual({ kind: "studio", ref });
    expect(parseBaseHost(`x.${ref}.base.levant.test`)).toBeNull();
    expect(parseBaseHost(`${ref}.levant.test`)).toBeNull();
    expect(parseBaseHost(`abc.base.levant.test`)).toBeNull();
  });
});

describe("secrets + API keys", () => {
  it("generates unique, strong per-project secrets (never upstream defaults)", async () => {
    const a = await generateSecrets("aaaaaaaaaaaaaaaaaaaa");
    const b = await generateSecrets("bbbbbbbbbbbbbbbbbbbb");
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
    expect(a.jwtSecret.length).toBeGreaterThanOrEqual(40);
    expect(a.postgresPassword).toMatch(DB_PASSWORD_RE);
    expect(a.vaultEncKey).toHaveLength(32);
    expect(a.realtimeDbEncKey).toHaveLength(16);
    expect(a.secretKeyBase.length).toBeGreaterThanOrEqual(64);
    expect(a.studioGateSecret.length).toBeGreaterThanOrEqual(32);
    const upstreamExample = fs.readFileSync(path.join(repo, "base-stack/upstream/.env.example"), "utf8");
    for (const v of Object.values(a)) expect(upstreamExample.includes(v)).toBe(false);
    expect(Object.values(a).includes("supabaserealtime")).toBe(false);
  });
  it("signs HS256 anon/service_role keys verifiable with the project secret only", async () => {
    const s = await generateSecrets("cccccccccccccccccccc");
    expect(decodeProtectedHeader(s.anonKey)).toMatchObject({ alg: "HS256", typ: "JWT" });
    const anon = await verifyApiKey(s.anonKey, s.jwtSecret);
    const svc = await verifyApiKey(s.serviceRoleKey, s.jwtSecret);
    expect(anon).toMatchObject({ role: "anon", iss: JWT_ISSUER, ref: "cccccccccccccccccccc" });
    expect(svc.role).toBe("service_role");
    expect((svc.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeGreaterThan(5 * 365 * 86400);
    const other = await generateSecrets("dddddddddddddddddddd");
    await expect(verifyApiKey(s.anonKey, other.jwtSecret)).rejects.toThrow();
    const k = await signApiKey("x".repeat(40), "anon", "eeeeeeeeeeeeeeeeeeee", 1000);
    expect(decodeJwt(k)).toMatchObject({ iat: 1000, role: "anon" });
  });
  it("accepts only URL/env-safe custom database passwords", async () => {
    await expect(generateSecrets("ffffffffffffffffffff", { dbPassword: "short" })).rejects.toThrow();
    await expect(generateSecrets("ffffffffffffffffffff", { dbPassword: "has$dollar-and-more-chars" })).rejects.toThrow();
    expect((await generateSecrets("ffffffffffffffffffff", { dbPassword: "Abcdefgh12345678" })).postgresPassword).toBe("Abcdefgh12345678");
  });
});

describe("limits", () => {
  it("splits the plan budget across services: ceilings sum exactly to the plan memory, floors respected", () => {
    const core = ["db", "realtime", "functions", "storage", "meta", "imgproxy", "gateway", "auth", "rest"];
    for (const plan of [BASE_PLAN_DEFAULTS.free, BASE_PLAN_DEFAULTS.pro, { cpus: 0.5, memoryMb: 1024 }]) {
      const r = serviceResources(plan);
      expect(core.reduce((s, k) => s + parseInt(r[k]!.memory), 0)).toBe(plan.memoryMb);
      for (const k of core) expect(Number(r[k]!.cpus)).toBeLessThanOrEqual(plan.cpus);
    }
    expect(BASE_PLAN_DEFAULTS.free.memoryMb).toBeGreaterThanOrEqual(MIN_STACK_MEMORY_MB);
    expect(parseInt(serviceResources(BASE_PLAN_DEFAULTS.free).db!.memory)).toBeGreaterThanOrEqual(256);
    expect(parseInt(serviceResources({ cpus: 0.5, memoryMb: 1024 }).db!.memory)).toBeLessThan(256); // scaled down
  });
  it("merges plan limits and overrides type-safely", () => {
    const m = mergeLimits(BASE_PLAN_DEFAULTS.free, { maxUploadMb: 100, pauseAfterDays: null, cpus: "x" as unknown as number });
    expect(m.maxUploadMb).toBe(100);
    expect(m.pauseAfterDays).toBeNull();
    expect(m.cpus).toBe(0.5);
  });
});

describe("versions", () => {
  it("match the vendored upstream compose file", () => {
    const upstream = fs.readFileSync(path.join(repo, "base-stack/upstream/docker-compose.yml"), "utf8");
    for (const img of Object.values(DEFAULT_VERSIONS)) expect(upstream).toContain(`image: ${img}`);
  });
  it("applies the registry mirror prefix to Docker Hub images only", () => {
    expect(imageRef("supabase/postgres:17", "mirror.gcr.io")).toBe("mirror.gcr.io/supabase/postgres:17");
    expect(imageRef("nginx:1", "mirror.gcr.io/")).toBe("mirror.gcr.io/library/nginx:1");
    expect(imageRef("ghcr.io/x/y:1", "mirror.gcr.io")).toBe("ghcr.io/x/y:1");
    expect(imageRef("supabase/postgres:17", "")).toBe("supabase/postgres:17");
    expect(resolveVersions({ db: "supabase/postgres:18.0", bogus: "x", rest: "bad image" }).db).toBe("supabase/postgres:18.0");
    expect(resolveVersions({ rest: "bad image" }).rest).toBe(DEFAULT_VERSIONS.rest);
  });
});

async function input(over: Partial<RenderInput> = {}): Promise<RenderInput> {
  const ref = "ghijklmnopqrstuvwxyz";
  return {
    ref,
    secrets: await generateSecrets(ref),
    settings: readSettings({}),
    limits: BASE_PLAN_DEFAULTS.free,
    versions: resolveVersions({}),
    publicUrl: `https://${ref}.base.levant.test`,
    publicNetwork: "levant_net",
    ...over,
  };
}

describe("template rendering", () => {
  it("renders every variable the template references", async () => {
    const i = await input();
    const { env } = buildEnv(i);
    const tpl = fs.readFileSync(path.join(repo, "base-stack/template/docker-compose.yml"), "utf8");
    const vars = new Set([...tpl.matchAll(/\$\{([A-Z0-9_]+)(:-[^}]*)?\}/g)].filter((m) => !m[2]).map((m) => m[1]!));
    const missing = [...vars].filter((v) => !(v in env));
    expect(missing).toEqual([]);
    expect(env.LB_REF).toBe(i.ref);
    expect(env.POSTGRES_PASSWORD).toBe(i.secrets.postgresPassword);
    expect(env.API_EXTERNAL_URL).toBe(`${i.publicUrl}/auth/v1`);
    expect(env.LB_FILE_SIZE_LIMIT).toBe(String(50 * 1024 * 1024));
    expect(env.LB_IMAGE_DB).toBe(DEFAULT_VERSIONS.db);
    expect(buildEnv(await input({ mirror: "mirror.gcr.io" })).env.LB_IMAGE_DB).toBe(`mirror.gcr.io/${DEFAULT_VERSIONS.db}`);
  });
  it("template has no host ports, no docker socket, and only the gateway on the public network", () => {
    const tpl = fs.readFileSync(path.join(repo, "base-stack/template/docker-compose.yml"), "utf8");
    expect(tpl).not.toMatch(/^\s+ports:/m);
    expect(tpl).not.toMatch(/docker\.sock/);
    expect(tpl.match(/^\s+public:\s*$/gm)?.length).toBe(2); // api-gw network entry + the networks section
    expect(tpl).toMatch(/internal: true/);
    expect(tpl).not.toMatch(/supabase-(db|auth|rest|storage|meta|studio|envoy)/); // upstream fixed container names
  });
  it("renders providers / SMTP / function secrets and quotes env values safely", async () => {
    const patch = baseSettingsPatchSchema.parse({
      auth: { siteUrl: "https://app.example.com", additionalRedirectUrls: ["https://app.example.com/**"] },
      smtp: { host: "smtp.example.com", port: 465, user: "u", pass: "p'a$s", adminEmail: "a@example.com", senderName: "App" },
      providers: { github: { enabled: true, clientId: "cid", secret: "csecret" } },
      authExtra: { GOTRUE_MFA_TOTP_ENROLL_ENABLED: "true" },
      functions: { verifyJwt: false, secrets: { STRIPE_KEY: "sk_test_1" } },
    });
    const { settings, changed } = applySettingsPatch(readSettings({}), patch);
    expect(changed.sort()).toEqual(["auth", "functions"]);
    expect(JSON.stringify(settings)).not.toContain("csecret");
    expect(JSON.stringify(publicSettings(settings))).not.toMatch(/csecret|sk_test_1|p'a/);
    const r = buildEnv(await input({ settings, noVerifyJwt: ["webhook"] }));
    expect(r.env.SMTP_PASS).toBe("p'a$s");
    expect(r.env.SITE_URL).toBe("https://app.example.com");
    expect(r.env.FUNCTIONS_VERIFY_JWT).toBe("false");
    expect(r.authEnv).toMatchObject({ GOTRUE_EXTERNAL_GITHUB_ENABLED: "true", GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: "cid", GOTRUE_EXTERNAL_GITHUB_SECRET: "csecret", GOTRUE_MFA_TOTP_ENROLL_ENABLED: "true" });
    expect(r.authEnv.GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI).toMatch(/\/auth\/v1\/callback$/);
    expect(r.functionsEnv).toMatchObject({ STRIPE_KEY: "sk_test_1", LEVANT_NO_VERIFY_JWT: "webhook" });
    const text = serializeEnv({ A: "plain", B: "p'a$s", C: 'x"y\\z' });
    expect(text).toBe(`A='plain'\nB="p'a$$s"\nC='x"y\\z'\n`);
    expect(() => serializeEnv({ A: "a\nb" })).toThrow();
    expect(() => applySettingsPatch(readSettings({}), { functions: { secrets: { SUPABASE_URL: "x" } } })).toThrow();
    expect(() => applySettingsPatch(readSettings({}), { authExtra: { GOTRUE_JWT_SECRET: "x" } })).toThrow();
  });
  it("writes the project directory (0600 env files, managed files refreshed, user functions kept)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-render-"));
    const i = await input();
    renderStack(i, { dir, template: path.join(repo, "base-stack/template") });
    expect(fs.existsSync(path.join(dir, "docker-compose.yml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "volumes/api/envoy/cds.template.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "volumes/functions/main/index.ts"))).toBe(true);
    expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
    fs.mkdirSync(path.join(dir, "volumes/functions/mine"));
    fs.writeFileSync(path.join(dir, "volumes/functions/mine/index.ts"), "x");
    fs.writeFileSync(path.join(dir, "volumes/functions/main/index.ts"), "tampered");
    renderStack(i, { dir, template: path.join(repo, "base-stack/template") });
    expect(fs.readFileSync(path.join(dir, "volumes/functions/mine/index.ts"), "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(dir, "volumes/functions/main/index.ts"), "utf8")).not.toBe("tampered");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("serves dashboard e-mail templates to GoTrue through the gateway (:8002) and keeps unknown settings keys", async () => {
    const st = readSettings({ customDomain: { hostname: "api.example.com", status: "ACTIVE" }, foo: 1 });
    expect((st as Record<string, unknown>).foo).toBe(1);
    const { settings } = applySettingsPatch(st, baseSettingsPatchSchema.parse({ templates: { recovery: { subject: "Reset", body: "<p>{{ .ConfirmationURL }}</p>" } } }));
    expect(settings.customDomain?.hostname).toBe("api.example.com");
    const i = await input({ settings });
    const r = buildEnv(i);
    expect(r.authEnv.GOTRUE_MAILER_TEMPLATES_RECOVERY).toBe(`http://lb_${i.ref}_api-gw:8002/templates/recovery`);
    expect(r.authEnv.GOTRUE_MAILER_SUBJECTS_RECOVERY).toBe("Reset");
    expect(r.authEnv.GOTRUE_MAILER_TEMPLATES_INVITE).toBeUndefined();
    expect(Object.keys(r.templates).sort()).toEqual(["confirmation", "email_change", "invite", "magic_link", "recovery"]);
    const h1 = r.env.LB_TEMPLATES_HASH;
    expect(buildEnv(await input()).env.LB_TEMPLATES_HASH).not.toBe(h1);
    const lds = fs.readFileSync(path.join(repo, "base-stack/template/volumes/api/envoy/lds.template.yaml"), "utf8");
    for (const id of Object.keys(r.templates)) expect(lds).toContain(`/etc/envoy/templates/${id}.html`);
  });
  it("public DB port: compose override only when enabled, TLS enforced, pooler gating", async () => {
    expect(publicOverride(54001)).toContain('"0.0.0.0:54001:5432"');
    expect(publicOverride(54001, "::")).toContain('"[::]:54001:5432"');
    expect(() => publicOverride(80)).toThrow();
    expect(() => publicOverride(54001, "0.0.0.0; rm")).toThrow();
    expect(parsePortRange("54000-54999")).toEqual([54000, 54999]);
    expect(() => parsePortRange("80-90")).toThrow();
    expect(buildEnv(await input()).env.LB_POOLER_ENFORCE_SSL).toBe("false");
    const on = buildEnv(await input({ dbPublicPort: 54001 })).env;
    expect(on.LB_POOLER_ENFORCE_SSL).toBe("true");
    expect(on.LB_DB_CERT_CN).toBe("ghijklmnopqrstuvwxyz.base.levant.test");
    const free = BASE_PLAN_DEFAULTS.free;
    expect(poolerEnabled({ dbPublicPort: null }, free)).toBe(false);
    expect(poolerEnabled({ dbPublicPort: 54001 }, free)).toBe(false); // plan has no public port
    expect(poolerEnabled({ dbPublicPort: null }, BASE_PLAN_DEFAULTS.pro)).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-pub-"));
    renderStack(await input({ dbPublicPort: 54002 }), { dir, template: path.join(repo, "base-stack/template") });
    expect(fs.readFileSync(path.join(dir, "docker-compose.public.yml"), "utf8")).toContain("54002:5432");
    renderStack(await input(), { dir, template: path.join(repo, "base-stack/template") });
    expect(fs.existsSync(path.join(dir, "docker-compose.public.yml"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
    const lds = fs.readFileSync(path.join(repo, "base-stack/template/volumes/api/envoy/lds.template.yaml"), "utf8");
    expect(lds).toMatch(/port_value: 5432[\s\S]*cluster: pooler_session/);
    expect(lds).toMatch(/port_value: 6543[\s\S]*cluster: pooler_tx/);
  });
  it("functions main router boots without outbound internet (vendored jose)", () => {
    const main = fs.readFileSync(path.join(repo, "base-stack/template/volumes/functions/main/index.ts"), "utf8");
    expect(main).not.toMatch(/from ['"](jsr|npm|https?):/);
    expect(fs.existsSync(path.join(repo, "base-stack/template/volumes/functions/main/_vendor/jose/index.js"))).toBe(true);
  });
  it("defaults are safe", () => {
    expect(DEFAULT_SETTINGS.functions.verifyJwt).toBe(true);
    expect(DEFAULT_SETTINGS.auth.enableAnonymousUsers).toBe(false);
  });
});

describe("proxy routes", () => {
  const ctx = { controlUpstream: "control:3000", dashboardHost: "deploy.levant.test" };
  const b = (status: BaseRoute["status"]): BaseRoute => ({
    ref: "abcdefghijklmnopqrst", apiHost: "abcdefghijklmnopqrst.base.levant.test", studioHost: "studio-abcdefghijklmnopqrst.base.levant.test", status,
    gatewayDial: "lb_abcdefghijklmnopqrst_api-gw:8000", studioDial: "lb_abcdefghijklmnopqrst_api-gw:8001", studioGateSecret: "g".repeat(48), maxBodyBytes: 51 * 1024 * 1024,
  });
  it("routes an active project to its gateway with the upload limit; studio behind forward-auth + gate header", () => {
    const routes = buildBaseRoutes(ctx, [b("ACTIVE")]) as Array<{ match: Array<{ host: string[]; path?: string[] }>; handle: Array<Record<string, unknown>> }>;
    const api = routes.find((r) => r.match[0]!.host[0]!.startsWith("abcdef"))!;
    expect(api.handle[0]).toMatchObject({ handler: "request_body", max_size: 51 * 1024 * 1024 });
    expect(api.handle[1]).toMatchObject({ handler: "reverse_proxy", upstreams: [{ dial: "lb_abcdefghijklmnopqrst_api-gw:8000" }], flush_interval: -1 });
    const sso = routes.find((r) => r.match[0]!.path?.[0] === "/__levant/sso")!;
    expect(JSON.stringify(sso.handle)).toContain("/api/internal/base/studio-sso");
    const studio = routes.find((r) => r.match[0]!.host[0]!.startsWith("studio-") && !r.match[0]!.path)!;
    expect(studio.handle[0]).toMatchObject({ handler: "reverse_proxy", rewrite: { uri: "/api/internal/base/studio-auth" } });
    expect(studio.handle[1]).toMatchObject({ upstreams: [{ dial: "lb_abcdefghijklmnopqrst_api-gw:8001" }], headers: { request: { set: { "X-Levant-Studio-Gate": ["g".repeat(48)] } } } });
    // studio upstream is never reachable without passing through the forward-auth handler first
    expect(routes.filter((r) => JSON.stringify(r).includes(":8001")).length).toBe(1);
  });
  it("routes an ACTIVE custom API domain to the same gateway", () => {
    const routes = buildBaseRoutes(ctx, [{ ...b("ACTIVE"), customHosts: ["api.example.com"] }]) as Array<{ match: Array<{ host: string[] }> }>;
    expect(routes[0]!.match[0]!.host).toEqual(["abcdefghijklmnopqrst.base.levant.test", "api.example.com"]);
    expect(JSON.stringify(baseErrorRoute(ctx, [{ ...b("ACTIVE"), customHosts: ["api.example.com"] }]))).toContain("api.example.com");
  });
  it("paused / provisioning projects get the branded page, no upstream, no studio", () => {
    for (const s of ["PAUSED", "PROVISIONING", "ERROR"] as const) {
      const json = JSON.stringify(buildBaseRoutes(ctx, [b(s)]));
      expect(json).not.toContain("api-gw:800");
      expect(json).toContain("/api/internal/base/page");
    }
    expect(renderBasePage(kindForStatus("PAUSED"), "x").status).toBe(503);
    expect(renderBasePage("paused", "x").html).toContain("Project paused — restore it from the dashboard");
  });
  it("is merged into the full Caddy config before the fallback page", () => {
    const state: ProxyState = {
      dashboardHost: ctx.dashboardHost, controlUpstream: ctx.controlUpstream, scheme: "https", tls: "internal", logDir: "/var/log/caddy",
      adminListen: "0.0.0.0:2019", adminOrigins: [], sites: [], redirects: [], bases: [b("ACTIVE")],
    };
    const cfg = buildCaddyConfig(state) as { apps: { http: { servers: { levant_https: { routes: Array<{ handle: Array<{ routes: unknown[] }> }>; errors: { routes: unknown[] } } } } } };
    const srv = cfg.apps.http.servers.levant_https;
    const sub = srv.routes[0]!.handle[0]!.routes;
    expect(JSON.stringify(sub[sub.length - 1])).toContain("/api/internal/pages/host");
    expect(JSON.stringify(sub)).toContain("lb_abcdefghijklmnopqrst_api-gw:8000");
    expect(JSON.stringify(srv.errors.routes[0])).toContain("/api/internal/base/page");
    expect(baseErrorRoute(ctx, [])).toBeNull();
  });
});

describe("quota enforcement", () => {
  const MB = 1024 * 1024;
  const l = { ...BASE_PLAN_DEFAULTS.free };
  const u = { dbSizeBytes: 100 * MB, storageSizeBytes: 100 * MB, mau: 10, teamEgressBytes: 0 };
  it("db read-only / uploads blocked with hysteresis, pause on MAU/egress only for auto-pausing plans", () => {
    expect(decideEnforcement(l, u, {})).toEqual({ dbReadOnly: false, uploadsBlocked: false, pause: null });
    expect(decideEnforcement(l, { ...u, dbSizeBytes: 501 * MB }, {}).dbReadOnly).toBe(true);
    expect(decideEnforcement(l, { ...u, dbSizeBytes: 490 * MB }, { dbReadOnly: true }).dbReadOnly).toBe(true);
    expect(decideEnforcement(l, { ...u, dbSizeBytes: 400 * MB }, { dbReadOnly: true }).dbReadOnly).toBe(false);
    expect(decideEnforcement(l, { ...u, storageSizeBytes: 1025 * MB }, {}).uploadsBlocked).toBe(true);
    expect(decideEnforcement({ ...l, enforce: { ...l.enforce, storage: false } }, { ...u, storageSizeBytes: 2048 * MB }, {}).uploadsBlocked).toBe(false);
    expect(decideEnforcement(l, { ...u, mau: 60_000 }, {}).pause).toMatch(/Monthly active users/);
    expect(decideEnforcement(l, { ...u, teamEgressBytes: 6 * 1024 * MB }, {}).pause).toMatch(/egress/);
    expect(decideEnforcement(BASE_PLAN_DEFAULTS.pro, { ...u, mau: 1e9 }, {}).pause).toBeNull();
  });
  it("blocks storage uploads in Caddy when flagged", () => {
    const r: BaseRoute = {
      ref: "abcdefghijklmnopqrst", apiHost: "a.base.levant.test", studioHost: "s.base.levant.test", status: "ACTIVE", gatewayDial: "g:8000",
      studioDial: "g:8001", studioGateSecret: "x".repeat(48), maxBodyBytes: 1, uploadsBlocked: true,
    };
    const routes = buildBaseRoutes({ controlUpstream: "c:3000", dashboardHost: "d" }, [r]) as Array<{ match: Array<{ path?: string[] }>; handle: Array<{ status_code?: number }> }>;
    expect(routes[0]!.match[0]!.path).toContain("/storage/v1/object/*");
    expect(routes[0]!.handle[0]!.status_code).toBe(507);
    expect(JSON.stringify(buildBaseRoutes({ controlUpstream: "c:3000", dashboardHost: "d" }, [{ ...r, uploadsBlocked: false }]))).not.toContain("507");
    const ro = buildBaseRoutes({ controlUpstream: "c:3000", dashboardHost: "d" }, [{ ...r, uploadsBlocked: false, dbReadOnly: true }]) as Array<{ match: Array<{ path?: string[]; method?: string[] }> }>;
    expect(ro[0]!.match[0]).toMatchObject({ path: ["/rest/v1/*"], method: ["POST", "PUT", "PATCH", "DELETE"] });
  });
});

describe("functions deploy + ownership fix", () => {
  it("replaces a function dir atomically: fewer files on redeploy leave nothing behind, _shared/other functions untouched", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "lb-fn-"));
    const root = path.join(proj, "volumes", "functions");
    fs.mkdirSync(path.join(root, "_shared"), { recursive: true });
    fs.writeFileSync(path.join(root, "_shared", "cors.ts"), "shared");
    writeFunctionDir(root, "other", "o");
    writeFunctionDir(root, "api", "v1", { "lib/a.ts": "a", "lib/b.ts": "b", "index.ts": "ignored" });
    expect(fs.readFileSync(path.join(root, "api/index.ts"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(root, "api/lib/b.ts"))).toBe(true);
    writeFunctionDir(root, "api", "v2", { "lib/a.ts": "a2" });
    expect(fs.readFileSync(path.join(root, "api/index.ts"), "utf8")).toBe("v2");
    expect(fs.readFileSync(path.join(root, "api/lib/a.ts"), "utf8")).toBe("a2");
    expect(fs.existsSync(path.join(root, "api/lib/b.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "_shared/cors.ts"), "utf8")).toBe("shared");
    expect(fs.readFileSync(path.join(root, "other/index.ts"), "utf8")).toBe("o");
    expect(() => writeFunctionDir(root, "api", "x", { "../_shared/cors.ts": "evil" })).toThrow(/Invalid file path/);
    expect(() => writeFunctionDir(root, "api", "x", { "/etc/passwd": "evil" })).toThrow(/Invalid file path/);
    expect(() => writeFunctionDir(root, "_shared", "x")).toThrow();
    expect(fs.readFileSync(path.join(root, "api/index.ts"), "utf8")).toBe("v2"); // failed deploys don't touch the live dir
    expect(fs.readdirSync(path.join(proj, "volumes", ".fn-staging"))).toEqual([]);
    fs.rmSync(proj, { recursive: true, force: true });
  });
  it("ownership fix SQL covers user schemas only and skips extension objects", () => {
    const sql = ownershipFixSql();
    for (const s of ["auth", "storage", "realtime", "extensions", "vault", "graphql"]) {
      expect(PLATFORM_SCHEMAS).toContain(s);
      expect(sql).toContain(`'${s}'`);
    }
    expect(sql).toContain("n.nspname <> 'public'"); // public schema owner unchanged
    expect(sql).toContain("deptype = 'e'");
    expect(sql).toMatch(/'materialized view'/);
    expect(sql).toMatch(/owner to postgres/);
    expect(sql).not.toMatch(/owner to supabase_admin/);
    expect((markOwnershipFixed({ a: 1 }).maintenance as { ownershipFixedAt: string }).ownershipFixedAt).toBeTruthy();
  });
});

describe("studio cookie", () => {
  it("is bound to ref + expiry + signature", () => {
    const ref = "abcdefghijklmnopqrst";
    const c = signStudioCookie(ref, "user1", Date.now());
    expect(parseStudioCookie(c, ref)).toEqual({ userId: "user1" });
    expect(parseStudioCookie(c, "bbbbbbbbbbbbbbbbbbbb")).toBeNull();
    expect(parseStudioCookie(c.replace("user1", "user2"), ref)).toBeNull();
    expect(parseStudioCookie(c, ref, Date.now() + 13 * 3600_000)).toBeNull();
    expect(parseStudioCookie("garbage", ref)).toBeNull();
  });
});

describe("usage + misc", () => {
  it("aggregates Caddy access-log lines per base project", () => {
    const ref = "abcdefghijklmnopqrst";
    const l = (host: string, uri: string, size: number, ts = 1000) => JSON.stringify({ ts, size, request: { host, uri } });
    const acc = aggregateBaseAccess([
      l(`${ref}.base.levant.test`, "/rest/v1/todos", 100),
      l(`${ref}.base.levant.test:443`, "/functions/v1/hello", 50, 2000),
      l(`studio-${ref}.base.levant.test`, "/", 9999),
      l("other.levant.test", "/", 1),
      "not json",
    ]);
    expect(acc.get(ref)).toEqual({ requests: 2, fn: 1, egress: 150, last: 2_000_000 });
    expect(acc.size).toBe(1);
  });
  it("parses psql CSV output", () => {
    expect(parseCsv('a,b\n1,"x,""y"""\n2,\n')).toEqual([["a", "b"], ["1", 'x,"y"'], ["2", ""]]);
    expect(parseLastCsv("id,title\n1,hello\n")).toEqual({ columns: ["id", "title"], rows: [{ id: "1", title: "hello" }] });
  });
  it("status transitions", () => {
    expect(canTransition("ACTIVE", "PAUSING")).toBe(true);
    expect(canTransition("PAUSED", "ACTIVE")).toBe(true);
    expect(canTransition("DELETING", "ACTIVE")).toBe(false);
    expect(canTransition("PROVISIONING", "ERROR")).toBe(true);
  });
});
