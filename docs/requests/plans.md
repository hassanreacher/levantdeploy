# plans area (wave C) — Plans & limits, metering, open registration

Status: DONE. Isolation: DB `levantdeploy_plans`, Redis db 9, port 3109 (`control/.env.plans`, gitignored).
Tests: `src/lib/plans/plans.test.ts` (unit, fake usage), e2e `control/tests/plans/e2e.ts`. Screenshots: `docs/screenshots/plans/`.

## Schema (additive, `npx prisma db push`)
- `Plan` (slug unique, name, description, priceMonthly Int? display only, `limits` Json = PlanLimits, isDefault, isInternal, sortOrder, archivedAt)
- `Team.planId` → Plan (SetNull). **null = automatic**: teams where an OWNER is the platform owner get the internal `unlimited` plan, others the default plan (Hobby).
- `UsageCounter` (teamId, period "YYYY-MM", resource, value, cursor) — monthly bandwidth accumulated from MetricSample (survives `metrics.retentionDays`).
- `PlanUsageAlert` (teamId, resource[@scopeId], period, level 80|100) — alert dedupe.
- `PlanUpgradeRequest` (teamId, requestedById, planId?, message, status OPEN|APPROVED|DISMISSED).
- `EmailVerification` (userId, email, tokenHash, expiresAt, usedAt). Back-relations on `User` (emailVerifications, planRequests) and `Team` (plan, usageCounters, usageAlerts, planRequests).
- Lead: `prisma/migrations/0001_init` was not regenerated (run `scripts/regen-initial-migration.sh` before release).

## Seed / bootstrap
`ensureDefaultPlans()` (seed + worker start, idempotent, never overwrites edits): Hobby (default), Pro, Team, Unlimited (internal).
Once per installation it also marks all pre-existing users email-verified (setting row `plans.bootstrappedAt`) so turning verification on doesn't lock out old accounts.

## Limits (`src/lib/plans/limits.ts`, pure)
`PlanLimits = { deploy: {projects, deploymentsPerDay, concurrentBuilds, buildTimeoutMinutes, buildMemoryMb, buildMinutesMonth, bandwidthGbMonth, members, domainsPerProject, uploadMb, previewDeployments}, base: {projects (active backends), dbSizeMb, storageMb, maxUploadMb, mau, egressGbMonth, functionInvocationsMonth, functions, pauseAfterDays, backupsKept, publicDbPort, cpu, memoryMb}, enforce: {"deploy.projects": bool, …} }`
— numbers `null` = unlimited; `enforce[resource] === false` = warn only. Defaults exactly as BASE-SPEC (Team = Pro with higher numbers).
`LIMIT_FIELDS` + `limitsJsonSchema()` drive the admin form (also served by `GET /api/v1/platform/plans`).

## Enforcement hooks (`import { … } from "@/lib/plans"` — worker-safe)
```ts
planFor(teamId): Promise<TeamPlan>                         // { plan: {id, slug, name, priceMonthly, isInternal, isDefault}, limits, source: "assigned"|"owner"|"default" }
assertCanCreateProject(teamId, product: "deploy"|"base", { userId? }): Promise<TeamPlan>   // projects | active backends (+ email verified)
assertCanDeploy(teamId, { userId?, preview?, strictConcurrency? }): Promise<TeamPlan>      // deployments/24h, monthly bandwidth (enforced), preview allowed; concurrency only with strictConcurrency
assertWithinUploadLimit(teamId, bytes, product: "deploy"|"base"): Promise<TeamPlan>       // deploy.uploadMb | base.maxUploadMb
assertCanAddMember(teamId, { pendingIncluded? }): Promise<TeamPlan>                         // members + pending invites
assertCanAddDomain(projectId, adding = 1): Promise<TeamPlan>                               // custom domains / project
assertCanAddFunction(baseProjectIdOrRef): Promise<TeamPlan>                                // functions / backend
assertEmailVerified(userId)                                                                 // 403 EMAIL_UNVERIFIED (platform owner exempt; setting auth.requireEmailVerification)
baseResourceLimits(teamId): Promise<BaseLimits & { plan, enforce: {dbSize, storage, mau, egress, invocations, functions, projects, upload}, memoryBytes, nanoCpus }>
buildLimits(teamId): Promise<{ concurrentBuilds, timeoutMinutes, memoryMb, plan }>
usageReport(teamId) / backendsUsage(teamId) / rollupBandwidth(teamId) / checkQuotas(teamId)
```
Errors: `PlanLimitError` → HTTP **402** `{ error: { code: "PLAN_LIMIT", message, resource, limit, used, plan: {slug,name}, upgradeUrl: "/{team}/settings/plan" } }`;
`EmailUnverifiedError` → **403** `{ error: { code: "EMAIL_UNVERIFIED", message, resendUrl } }`. Both expose `publicError()`; `errorResponse()` in `src/lib/http.ts` renders any error with `publicError()` (small additive change), so they work from worker-safe libs without importing `http.ts`.

## Wiring done in Deploy code paths (minimal additive calls)
| path | hook |
|---|---|
| `POST /api/v1/projects` | `assertCanCreateProject(team,"deploy",{userId})` + `assertCanDeploy` when the first deployment will be created |
| `POST /api/v1/projects/:id/transfer` | `assertCanCreateProject(targetTeam,"deploy")` |
| `createDeployment()` (`src/lib/deployments.ts`) — covers Deploy button, redeploy, promote, uploads deploy, CLI, GitHub webhooks, git polling, deploy hooks, AI tools | `assertCanDeploy(project.teamId, { userId: createdById, preview: target === "PREVIEW" })` |
| build worker (`src/worker/processors/build.ts`) | per-team build slots (`buildLimits().concurrentBuilds`, extra builds stay QUEUED and log "Waiting for a build slot…") + plan build timeout (min of plan and `build.timeoutMinutes`) |
| `POST /api/v1/uploads` (init) | `assertWithinUploadLimit(team, size, "deploy")` |
| `POST /api/v1/teams/:team/invites` | `assertCanAddMember(team)`; `acceptInvite()` (`src/lib/auth/register.ts`) re-checks with `pendingIncluded` |
| `addDomain()` (`src/lib/domains/service.ts`) | `assertCanAddDomain(project.id)`; the www/apex counterpart is silently skipped when it would exceed |
| `/api/v1/auth/register` | `assertSignupAllowed()` (per-IP limit, terms, disposable blocklist) + verification email; closed mode |

Notes for owners of those files: git polling / GitHub webhooks now get a `PlanLimitError` from `createDeployment()` when a team is out of deployments for the day (the push is not deployed; the webhook/poll surfaces the error). If you want a softer behaviour (e.g. a failed commit status "Plan limit reached"), catch `isPlanLimitError(e)` there.
A waiting build occupies one BullMQ build-worker slot (`WORKER_CONCURRENCY_BUILD`, default 4) while it waits for its team slot.

## Base side — for base-runtime / base-dashboard (please call these)
- Create backend (`createBaseProject` / `POST /api/v1/base/projects`): `await assertCanCreateProject(teamId, "base", { userId })` (active = status not PAUSED/PAUSING/DELETING). Resume of a paused backend should call it too (it becomes active again).
- Deploy function: `await assertCanAddFunction(ref)` before creating a **new** `BaseFunction` (updates of an existing slug don't count).
- Storage upload limit / Kong `client_max_body_size` / storage `FILE_SIZE_LIMIT`: `baseResourceLimits(teamId).maxUploadMb`; API-side uploads through control: `assertWithinUploadLimit(teamId, bytes, "base")`.
- Compose rendering: `baseResourceLimits(teamId)` → `cpu` / `memoryMb` (`nanoCpus`, `memoryBytes`) per backend, `pauseAfterDays` (auto-pause job; null = never), `backupsKept` (0 = manual dump only), `publicDbPort` (refuse to open a public port when false → throw `new PlanLimitError("base.publicDbPort", 0, 0, tp.plan, teamSlug)` or just 402).
- Soft caps → restrict when `enforce.*` is true: DB over `dbSizeMb` → `ALTER DATABASE postgres SET default_transaction_read_only = on`; storage over `storageMb` → block uploads; Hobby egress/MAU over → pause. `usageReport(teamId).all` gives per-backend items (`scope: {kind:"backend", id, name}`) with `ratio`.
- Usage: we read `BaseUsageSample` as written by base-runtime: gauges from the latest sample (`dbSizeBytes`, `storageSizeBytes`, `mau`) and monthly sums of the per-sample deltas (`egressBytes`, `functionInvocations`, `requests`). If those semantics change, update `backendsUsage()` in `src/lib/plans/usage.ts`.
- 402 errors from these hooks render with the same `PLAN_LIMIT` shape; the dashboard banner (`PlanLimitListener`) picks them up automatically for any `api()` call.

## Quota warnings
Worker queue `plans` (added to `QUEUE_NAMES` + `JobData`): schedule every 10 min → `checkAllQuotas()` (rolls up bandwidth, records `PlanUsageAlert`, enqueues `notify` `{ event: "plan.quota_warning" | "plan.quota_exceeded", teamId, payload }`).
The `notify` processor (dashboard area file, additive branch) routes `plan.*` events to `dispatchPlanEvent()`: in-app notifications for team OWNER/ADMINs at 80 % and 100 %, plus email to OWNERs at 100 %; `plan.upgrade_request` → all platform owners (in-app + email).

## API
```
GET  /api/v1/teams/:team/plan                       plan, source, limits, usage report (deploy, base, per project + backend), plans to compare, open request
POST /api/v1/teams/:team/plan/upgrade-request       { plan?, message? } (ADMIN) → notifies the platform owner
GET|POST /api/v1/platform/plans                     list (+ JSON schema, fields, open requests) / create
PATCH|DELETE /api/v1/platform/plans/:id|slug        edit (incl. archived, isDefault) / delete when unused
GET  /api/v1/platform/plans/teams?overQuota=1       teams with plan, source, over-quota items
POST /api/v1/platform/plans/assign                  { team, plan: id|slug|null }
PATCH /api/v1/platform/plans/requests/:id           { status: APPROVED|DISMISSED }
GET|PATCH /api/v1/platform/signups                  registration open|invite|closed, verification, disposable blocklist (+ extra domains), per-IP sign-up limit, terms (+ URLs)
POST /api/v1/auth/verify-email { token }            consume link (signed in or out)
POST /api/v1/auth/verify-email/resend               signed-in user, 3 / 15 min
```

## Settings (`src/lib/settings.ts`, additive)
`platform.registration` now `open|invite|closed`, **default `open`** (was invite). New: `auth.requireEmailVerification` (true), `auth.blockDisposableEmails` (true), `auth.disposableDomains` ([]), `auth.signupRateLimit` ({limit: 5, windowMinutes: 60}), `auth.requireTerms` (true), `auth.termsUrl`, `auth.privacyUrl`.
The old fixed `register:<ip>` limit in the register route is relaxed to a 10× flood guard; the configurable one is `auth.signupRateLimit`.

## UI
- Team Settings → **Plan & Usage** (`/{team}/settings/plan`): plan card + "Request upgrade" dialog, Deploy usage bars, Backends usage bars, per-project groups (custom domains + attached backend: DB size, storage, MAU, functions), standalone backends, plan comparison. Wording "Backends" (product decision: Deploy and Base are one product).
- Platform Settings → **Plans** (`/settings/plans`): upgrade requests (assign / dismiss), plan list, schema-driven editor for every limit with per-resource Enforce switch, default/internal/archive/delete, teams list with plan select and over-quota filter. **Sign-ups** (`/settings/signups`). General → Registration select gained "Closed".
- `PlanLimitListener` (mounted in `[team]/layout.tsx`): `api()` dispatches `ld:plan-limit` for every 402/403 plan error → floating banner explaining the limit with a link to Plan & Usage (or "Resend verification email"). `ApiClientError.details` carries the whole error object.
- `VerifyEmailBanner` above the dashboard for unverified accounts; `/verify-email?token=` page (public, token consumed by a client POST so link scanners can't burn it); register form: terms checkbox, "Registration closed" state.
- Command palette: "Plan & Usage".
