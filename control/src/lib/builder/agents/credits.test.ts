import { afterEach, describe, expect, it } from "vitest";
import { assertCanUseBuilder, assertCanCreateBuilderProject, builderCredits, setPlanDeps, PlanLimitError } from "@/lib/plans";
import { HOBBY_LIMITS, PRO_LIMITS, TEAM_LIMITS, UNLIMITED_LIMITS, parseLimits, defaultLimitsForSlug, type PlanLimits } from "@/lib/plans/limits";

const NOW = new Date("2026-10-10T12:00:00Z");
const at = (iso: string, n: number) => Array.from({ length: n }, () => new Date(iso));

function setup(limits: PlanLimits, times: Date[], projects = 0) {
  setPlanDeps({
    planFor: async () => ({ plan: { id: "p", slug: "x", name: "Plan", priceMonthly: 0, isInternal: false, isDefault: true }, limits, source: "default" }),
    teamSlug: async () => "acme",
    user: async () => ({ emailVerifiedAt: new Date(), isPlatformOwner: false }),
    counters: { builderMessageTimes: async (_t, since) => times.filter((t) => t >= since), builderProjects: async () => projects },
  });
}
afterEach(() => setPlanDeps());

describe("builder credits (plans)", () => {
  it("Hobby: 5 per day", async () => {
    setup(HOBBY_LIMITS, at("2026-10-10T08:00:00Z", 4));
    expect((await assertCanUseBuilder("t", { now: NOW })).remainingToday).toBe(1);
    setup(HOBBY_LIMITS, at("2026-10-10T08:00:00Z", 5));
    const e = await assertCanUseBuilder("t", { now: NOW }).catch((x) => x);
    expect(e).toBeInstanceOf(PlanLimitError);
    expect((e as PlanLimitError).resource).toBe("builder.messagesPerDay");
    expect((e as PlanLimitError).publicError().status).toBe(402);
  });
  it("Hobby: 30 per month", async () => {
    setup(HOBBY_LIMITS, [...at("2026-10-01T08:00:00Z", 5), ...at("2026-10-02T08:00:00Z", 5), ...at("2026-10-03T08:00:00Z", 5), ...at("2026-10-04T08:00:00Z", 5), ...at("2026-10-05T08:00:00Z", 5), ...at("2026-10-06T08:00:00Z", 5)]);
    const e = await assertCanUseBuilder("t", { now: NOW }).catch((x) => x);
    expect((e as PlanLimitError).resource).toBe("builder.messagesPerMonth");
    // last month's messages don't count
    setup(HOBBY_LIMITS, at("2026-09-30T08:00:00Z", 40));
    expect((await builderCredits("t", NOW)).allowed).toBe(true);
  });
  it("Pro: 100/month + 5 daily bonus", async () => {
    // 100 paid this month (5 bonus/day on two days used on top) → still 5 bonus today
    setup(PRO_LIMITS, [...at("2026-10-01T08:00:00Z", 55), ...at("2026-10-02T08:00:00Z", 55)]);
    let c = await builderCredits("t", NOW);
    expect(c.bonusUsedMonth).toBe(10);
    expect(c.remainingMonth).toBe(0);
    expect(c.allowed).toBe(true);
    expect(c.remainingToday).toBe(5);
    setup(PRO_LIMITS, [...at("2026-10-01T08:00:00Z", 55), ...at("2026-10-02T08:00:00Z", 55), ...at("2026-10-10T08:00:00Z", 5)]);
    c = await builderCredits("t", NOW);
    expect(c.allowed).toBe(false);
    expect(c.reason).toBe("monthly");
  });
  it("Team 500/month, unlimited for the owner, enforce flag", async () => {
    setup(TEAM_LIMITS, at("2026-10-10T08:00:00Z", 499));
    expect((await builderCredits("t", NOW)).allowed).toBe(true);
    setup(TEAM_LIMITS, at("2026-10-10T08:00:00Z", 500));
    expect((await builderCredits("t", NOW)).allowed).toBe(false);
    setup(UNLIMITED_LIMITS, at("2026-10-10T08:00:00Z", 5000));
    expect((await builderCredits("t", NOW)).allowed).toBe(true);
    setup({ ...HOBBY_LIMITS, enforce: { ...HOBBY_LIMITS.enforce, "builder.messages": false } }, at("2026-10-10T08:00:00Z", 50));
    expect((await builderCredits("t", NOW)).allowed).toBe(true);
  });
  it("builder projects: Hobby 5", async () => {
    setup(HOBBY_LIMITS, [], 4);
    await assertCanCreateBuilderProject("t");
    setup(HOBBY_LIMITS, [], 5);
    await expect(assertCanCreateBuilderProject("t")).rejects.toBeInstanceOf(PlanLimitError);
  });
  it("older stored plans get builder defaults by slug", () => {
    const { builder: _b, ...stored } = PRO_LIMITS;
    expect(parseLimits(stored, defaultLimitsForSlug("pro")).builder.messagesPerMonth).toBe(100);
    expect(parseLimits(stored).builder.messagesPerDay).toBe(5);
  });
});
