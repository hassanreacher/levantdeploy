/**
 * Plans & limits (plans area) — public surface. Worker-safe (no next/* imports).
 * See docs/requests/plans.md for the contract used by the Deploy code paths and the Base agents.
 */
export {
  planFor,
  assertCanCreateProject,
  assertCanDeploy,
  assertWithinUploadLimit,
  assertCanAddMember,
  assertCanAddDomain,
  assertCanAddFunction,
  assertEmailVerified,
  baseResourceLimits,
  buildLimits,
  setPlanDeps,
  assertCanUseBuilder,
  assertCanCreateBuilderProject,
  builderCredits,
  type BuilderCredits,
  type BaseResourceLimits,
  type PlanDeps,
} from "./enforce";
export { PlanLimitError, EmailUnverifiedError, isPlanLimitError } from "./errors";
export { ensureDefaultPlans, assignPlan, listPlans, setDefaultPlan, isPlatformOwnerTeam, type TeamPlan, type PlanInfo } from "./plans";
export { usageReport, backendsUsage, rollupBandwidth, counters, type UsageReport, type UsageItem, type BackendUsage, type ProjectUsageGroup } from "./usage";
export { checkQuotas, checkAllQuotas, dispatchPlanEvent, isPlanEvent, PLAN_EVENTS } from "./alerts";
export * from "./limits";
