import { afterEach, describe, expect, it } from "vitest";
import {
  assertCanAddDomain,
  assertCanAddFunction,
  assertCanAddMember,
  assertCanCreateProject,
  assertCanDeploy,
  assertWithinUploadLimit,
  baseResourceLimits,
  buildLimits,
  setPlanDeps,
  type PlanDeps,
} from "./enforce";
import { PlanLimitError, EmailUnverifiedError } from "./errors";
import { HOBBY_LIMITS, PRO_LIMITS, UNLIMITED_LIMITS, TEAM_LIMITS, parseLimits, limitOf, usageRatio, limitsJsonSchema, LIMIT_FIELDS, RESOURCES, planLimitsSchema, type PlanLimits } from "./limits";
import type { TeamPlan } from "./plans";
import { alertLevel, quotaMessage } from "./alerts";
import { isDisposableDomain, emailDomain } from "./signup";
import { fmtValue, fmtLimit, tone } from "@/components/plans/format";

const GB = 1024 ** 3;

function tp(limits: PlanLimits, name = "Hobby"): TeamPlan {
  return { plan: { id: "p1", slug: name.toLowerCase(), name, priceMonthly: 0, isInternal: false, isDefault: true }, limits, source: "default" };
}

/** Fake usage: every counter returns the configured number. */
function fake(limits: PlanLimits, usage: Partial<Record<keyof PlanDeps["counters"], number>> = {}, extra: Partial<PlanDeps> = {}) {
  const n = (k: keyof PlanDeps["counters"]) => async () => usage[k] ?? 0;
  setPlanDeps({
    planFor: async () => tp(limits),
    teamSlug: async () => "acme",
    projectTeam: async () => "team1",
    backendTeam: async (id) => ({ id, teamId: "team1" }),
    user: async () => ({ emailVerifiedAt: new Date(), isPlatformOwner: false }),
    verificationRequired: async () => true,
    counters: {
      projects: n("projects"),
      deploymentsSince: n("deploymentsSince"),
      buildingNow: n("buildingNow"),
      members: n("members"),
      customDomains: n("customDomains"),
      activeBackends: n("activeBackends"),
      backendFunctions: n("backendFunctions"),
      bandwidthBytesMonth: n("bandwidthBytesMonth"),
    },
    ...extra,
  });
}

async function limitErr(p: Promise<unknown>): Promise<PlanLimitError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PlanLimitError);
    return e as PlanLimitError;
  }
  throw new Error("expected a PlanLimitError");
}

afterEach(() => setPlanDeps());

describe("default plans (BASE-SPEC Plans & limits)", () => {
  it("Hobby matches the spec", () => {
    expect(HOBBY_LIMITS.deploy).toMatchObject({ projects: 200, deploymentsPerDay: 100, concurrentBuilds: 1, buildTimeoutMinutes: 45, bandwidthGbMonth: 100, buildMemoryMb: 4096, members: 1, previewDeployments: true, domainsPerProject: 50 });
    expect(HOBBY_LIMITS.base).toMatchObject({ projects: 2, dbSizeMb: 500, storageMb: 1024, maxUploadMb: 50, mau: 50_000, egressGbMonth: 5, functionInvocationsMonth: 500_000, functions: 10, pauseAfterDays: 7, backupsKept: 0, publicDbPort: false, cpu: 0.5, memoryMb: 1536 });
  });
  it("Pro matches the spec", () => {
    expect(PRO_LIMITS.deploy).toMatchObject({ projects: null, deploymentsPerDay: 6000, concurrentBuilds: 12, bandwidthGbMonth: 1024, members: null });
    expect(PRO_LIMITS.base).toMatchObject({ projects: null, dbSizeMb: 8192, storageMb: 102_400, maxUploadMb: 5120, mau: 100_000, egressGbMonth: 250, functionInvocationsMonth: 2_000_000, functions: 500, pauseAfterDays: null, backupsKept: 7, publicDbPort: true, cpu: 2, memoryMb: 4096 });
  });
  it("Team ≥ Pro everywhere, Unlimited has no numeric caps", () => {
    for (const f of LIMIT_FIELDS.filter((f) => f.type !== "boolean" && f.key !== "base.pauseAfterDays" && f.key !== "builder.dailyBonus")) {
      const pro = limitOf(PRO_LIMITS, f.key as never) ?? Infinity;
      const team = limitOf(TEAM_LIMITS, f.key as never) ?? Infinity;
      expect(team, f.key).toBeGreaterThanOrEqual(pro);
    }
    for (const r of RESOURCES) expect(limitOf(UNLIMITED_LIMITS, r), r).toBeNull();
  });
  it("every default validates against the schema; parseLimits fills missing keys", () => {
    for (const l of [HOBBY_LIMITS, PRO_LIMITS, TEAM_LIMITS, UNLIMITED_LIMITS]) expect(planLimitsSchema.safeParse(l).success).toBe(true);
    const partial = parseLimits({ deploy: { projects: 3 } });
    expect(partial.deploy.projects).toBe(3);
    expect(partial.base.projects).toBe(2);
    expect(parseLimits("garbage")).toEqual(HOBBY_LIMITS);
  });
  it("JSON schema covers every form field", () => {
    const s = limitsJsonSchema() as { properties: { deploy: { properties: object }; base: { properties: object }; builder: { properties: object } } };
    expect(Object.keys(s.properties.deploy.properties).length + Object.keys(s.properties.base.properties).length + Object.keys(s.properties.builder.properties).length).toBe(LIMIT_FIELDS.length);
  });
});

describe("assertCanCreateProject", () => {
  it("allows below the limit and rejects at it with PLAN_LIMIT details", async () => {
    fake({ ...HOBBY_LIMITS, deploy: { ...HOBBY_LIMITS.deploy, projects: 3 } }, { projects: 2 });
    await expect(assertCanCreateProject("team1", "deploy")).resolves.toBeTruthy();
    fake({ ...HOBBY_LIMITS, deploy: { ...HOBBY_LIMITS.deploy, projects: 3 } }, { projects: 3 });
    const e = await limitErr(assertCanCreateProject("team1", "deploy"));
    expect(e.publicError()).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", resource: "deploy.projects", limit: 3, used: 3, upgradeUrl: "/acme/settings/plan" } });
  });
  it("counts active backends for product base (Hobby: 2)", async () => {
    fake(HOBBY_LIMITS, { activeBackends: 1 });
    await assertCanCreateProject("team1", "base");
    fake(HOBBY_LIMITS, { activeBackends: 2 });
    expect((await limitErr(assertCanCreateProject("team1", "base"))).resource).toBe("base.projects");
  });
  it("unlimited / not enforced never blocks", async () => {
    fake(UNLIMITED_LIMITS, { projects: 1e6, activeBackends: 1e6 });
    await assertCanCreateProject("team1", "deploy");
    await assertCanCreateProject("team1", "base");
    fake({ ...HOBBY_LIMITS, enforce: { ...HOBBY_LIMITS.enforce, "deploy.projects": false } }, { projects: 500 });
    await assertCanCreateProject("team1", "deploy");
  });
  it("unverified users are blocked (403), platform owner and disabled verification are not", async () => {
    fake(HOBBY_LIMITS, {}, { user: async () => ({ emailVerifiedAt: null, isPlatformOwner: false }) });
    await expect(assertCanCreateProject("team1", "deploy", { userId: "u1" })).rejects.toBeInstanceOf(EmailUnverifiedError);
    await expect(assertCanDeploy("team1", { userId: "u1" })).rejects.toBeInstanceOf(EmailUnverifiedError);
    await assertCanCreateProject("team1", "deploy"); // no user (git webhook, worker) → no check
    fake(HOBBY_LIMITS, {}, { user: async () => ({ emailVerifiedAt: null, isPlatformOwner: true }) });
    await assertCanCreateProject("team1", "deploy", { userId: "u1" });
    fake(HOBBY_LIMITS, {}, { user: async () => ({ emailVerifiedAt: null, isPlatformOwner: false }), verificationRequired: async () => false });
    await assertCanCreateProject("team1", "deploy", { userId: "u1" });
    expect(new EmailUnverifiedError().publicError().status).toBe(403);
  });
});

describe("assertCanDeploy", () => {
  it("deployments per rolling day", async () => {
    fake(HOBBY_LIMITS, { deploymentsSince: 99 });
    await assertCanDeploy("team1");
    fake(HOBBY_LIMITS, { deploymentsSince: 100 });
    const e = await limitErr(assertCanDeploy("team1"));
    expect([e.resource, e.limit, e.used]).toEqual(["deploy.deploymentsPerDay", 100, 100]);
  });
  it("concurrent builds only reject in strict mode (otherwise builds queue)", async () => {
    fake(HOBBY_LIMITS, { buildingNow: 1 });
    await assertCanDeploy("team1");
    expect((await limitErr(assertCanDeploy("team1", { strictConcurrency: true }))).resource).toBe("deploy.concurrentBuilds");
  });
  it("monthly bandwidth blocks new deployments when enforced", async () => {
    fake(HOBBY_LIMITS, { bandwidthBytesMonth: 99 * GB });
    await assertCanDeploy("team1");
    fake(HOBBY_LIMITS, { bandwidthBytesMonth: 100 * GB });
    expect((await limitErr(assertCanDeploy("team1"))).resource).toBe("deploy.bandwidthGbMonth");
    fake({ ...HOBBY_LIMITS, enforce: { ...HOBBY_LIMITS.enforce, "deploy.bandwidthGbMonth": false } }, { bandwidthBytesMonth: 500 * GB });
    await assertCanDeploy("team1");
  });
  it("preview deployments can be switched off per plan", async () => {
    fake({ ...HOBBY_LIMITS, deploy: { ...HOBBY_LIMITS.deploy, previewDeployments: false } });
    await assertCanDeploy("team1");
    expect((await limitErr(assertCanDeploy("team1", { preview: true }))).resource).toBe("deploy.previewDeployments");
  });
});

describe("other hooks", () => {
  it("assertWithinUploadLimit (deploy unlimited on Hobby, base 50 MB)", async () => {
    fake(HOBBY_LIMITS);
    await assertWithinUploadLimit("team1", 10 * GB, "deploy");
    await assertWithinUploadLimit("team1", 50 * 1024 * 1024, "base");
    const e = await limitErr(assertWithinUploadLimit("team1", 50 * 1024 * 1024 + 1, "base"));
    expect([e.resource, e.limit]).toEqual(["base.maxUploadMb", 50]);
    fake({ ...HOBBY_LIMITS, deploy: { ...HOBBY_LIMITS.deploy, uploadMb: 10 } });
    expect((await limitErr(assertWithinUploadLimit("team1", 11 * 1024 * 1024, "deploy"))).resource).toBe("deploy.uploadMb");
  });
  it("assertCanAddMember: Hobby = owner only; accepting a counted invite is not double counted", async () => {
    fake(HOBBY_LIMITS, { members: 1 });
    expect((await limitErr(assertCanAddMember("team1"))).resource).toBe("deploy.members");
    await assertCanAddMember("team1", { pendingIncluded: true });
    fake(PRO_LIMITS, { members: 1000 });
    await assertCanAddMember("team1");
  });
  it("assertCanAddDomain: 50 per project on Hobby", async () => {
    fake(HOBBY_LIMITS, { customDomains: 49 });
    await assertCanAddDomain("proj1");
    fake(HOBBY_LIMITS, { customDomains: 50 });
    expect((await limitErr(assertCanAddDomain("proj1"))).resource).toBe("deploy.domainsPerProject");
  });
  it("assertCanAddFunction: 10 per backend on Hobby", async () => {
    fake(HOBBY_LIMITS, { backendFunctions: 9 });
    await assertCanAddFunction("ref123");
    fake(HOBBY_LIMITS, { backendFunctions: 10 });
    expect((await limitErr(assertCanAddFunction("ref123"))).resource).toBe("base.functions");
  });
  it("baseResourceLimits / buildLimits expose plan resources", async () => {
    fake(HOBBY_LIMITS);
    const b = await baseResourceLimits("team1");
    expect(b).toMatchObject({ cpu: 0.5, memoryMb: 1536, memoryBytes: 1536 * 1024 ** 2, nanoCpus: 5e8, dbSizeMb: 500, storageMb: 1024, maxUploadMb: 50, functions: 10, pauseAfterDays: 7, backupsKept: 0, publicDbPort: false });
    expect(b.enforce.dbSize).toBe(true);
    expect(await buildLimits("team1")).toMatchObject({ concurrentBuilds: 1, timeoutMinutes: 45, memoryMb: 4096 });
    fake(UNLIMITED_LIMITS);
    expect(await baseResourceLimits("team1")).toMatchObject({ cpu: null, memoryBytes: null, nanoCpus: null, pauseAfterDays: null });
  });
});

describe("alerts, signup, formatting", () => {
  it("alert levels at 80 % and 100 %", () => {
    expect(alertLevel({ limit: 100, ratio: usageRatio(79, 100) })).toBeNull();
    expect(alertLevel({ limit: 100, ratio: usageRatio(80, 100) })).toBe(80);
    expect(alertLevel({ limit: 100, ratio: usageRatio(100, 100) })).toBe(100);
    expect(alertLevel({ limit: null, ratio: 0 })).toBeNull();
    expect(usageRatio(1, 0)).toBe(Infinity);
    const m = quotaMessage({ resource: "deploy.bandwidthGbMonth", label: "Bandwidth / month", used: 100, limit: 100, unit: "GB", level: 100, enforced: true, plan: "Hobby" }, "Acme");
    expect(m.title).toContain("limit reached");
  });
  it("disposable domains incl. subdomains and extras", () => {
    expect(isDisposableDomain(emailDomain("x@Mailinator.com"))).toBe(true);
    expect(isDisposableDomain("eu.yopmail.com")).toBe(true);
    expect(isDisposableDomain("gmail.com")).toBe(false);
    expect(isDisposableDomain("spam.example", ["spam.example"])).toBe(true);
  });
  it("usage formatting", () => {
    expect(fmtLimit(null, "count")).toBe("Unlimited");
    expect(fmtValue(2048, "MB")).toBe("2 GB");
    expect(fmtValue(0.5, "GB")).toBe("512 MB");
    expect(fmtValue(50_000, "count")).toBe("50k");
    expect(tone(0.85, true)).toBe("warning");
    expect(tone(1, true)).toBe("danger");
    expect(tone(5, false)).toBe("muted");
  });
});
