# LevantDeploy — Conventions (foundation)

Read `docs/SPEC.md` first (binding). This file explains **how** to plug your area into the foundation.
Everything below lives in `control/` (the Next.js app + worker).

## 1. Folder layout

```
control/
  prisma/schema.prisma        ALL models (foundation-owned; additive fields OK → note in docs/requests/<area>.md, run npx prisma db push)
  prisma/seed.ts              dev seed (admin@levantdeploy.local / Admin@12345, team "Personal" (/admin), project demo-app)
  src/middleware.ts           CSRF + auth gate (edge, no DB)
  src/lib/
    env.ts                    zod-validated env (lazy): import { env, appUrl } from "@/lib/env"
    db.ts                     Prisma client: import { db } from "@/lib/db"
    redis.ts                  redis(), redisReady(), newRedis(), cached(), invalidate()
    http.ts                   route(), json(), ApiError, E, body(), query(), throttle(), requireSession(),
                              requireApiTokenOrSession(), requireTeamRole(), requireProjectRole(), requirePlatformOwner()
    crypto.ts                 encryptString/decryptString, encryptJson/decryptJson, sha256, hmacSha256, randomToken, randomId, timingSafeEqual, maskSecret
    queues.ts                 BullMQ queues + worker registry (registerProcessor / registerSchedule / onWorkerStart)
    logs.ts                   appendLog, endLogs, readLogs, archiveLogs, deleteLogs, logStreamResponse (SSE)
    deployments.ts            createDeployment, setStatus, cancelDeployment, isCancelRequested, URL builders, markCurrentProduction
    settings.ts               typed getSetting/setSetting over the Setting table
    audit.ts                  audit({...}) writer
    rate-limit.ts             rateLimit(key, limit, windowSec), LIMITS
    email.ts                  sendMail() (dev: printed to the console)
    docker.ts                 docker() dockerode client, LABELS, ensureNetwork()
    teams.ts                  slugify, RESERVED_TEAM_SLUGS / RESERVED_PROJECT_SLUGS, createTeam, teamsForUser
    ansi.ts                   ANSI → segments (used by LogViewer)
    utils.ts                  cn(), timeAgo(), formatDuration(), formatBytes()
    auth/                     jwt (edge-safe), session (cookie sessions), tokens (API tokens), totp, roles, password,
                              register (invites), context (getTeamContext/getProjectContext for pages), redirect
    client/api.ts             browser fetch helper api() + ApiClientError
  src/worker/index.ts         worker entry (npm run worker) — loads src/worker/processors/*.ts
  src/worker/processors/      ONE FILE PER AREA (build.ts, runtime.ts, domains.ts, notify.ts, …)
  src/components/ui/          UI kit (barrel: "@/components/ui")
  src/components/shell/       dashboard chrome: TopNav, SubNav, TeamSwitcher, UserMenu, ThemeToggle, CommandPalette, PageHeader, AreaPlaceholder, nav.ts
  src/app/(auth)/             login, register, forgot-password, reset-password, 2fa, invite/[token]
  src/app/(dashboard)/        account, [team]/(team)/{page,members,tokens,audit,settings,new}, [team]/[project]/{…tabs}
  src/app/api/v1/             REST API (session cookie or Bearer API token)
  src/app/api/internal/       machine endpoints (runtime area; CSRF-exempt, e.g. tls-ask)
  src/app/api/webhooks/       inbound webhooks (git area; CSRF-exempt, verify signatures!)
```

Rules: shared libs used by the worker must **not** import `server-only`, `next/headers` or `next/navigation`
(the worker runs under plain `tsx`). `http.ts`, `auth/session.ts` and `auth/context.ts` are Next-only.
Path alias `@/` → `src/` works in both.

## 2. Adding an API route

```ts
// src/app/api/v1/projects/[id]/env/route.ts
import { z } from "zod";
import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { encryptString } from "@/lib/crypto";

const schema = z.object({ key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), value: z.string() });

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "env:read" });
  return json({ items: await db.envVar.findMany({ where: { projectId: project.id } }) });
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);                       // 400 invalid JSON, 422 VALIDATION
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "env:write" });
  if (input.key === "PORT") throw E.bad("PORT is reserved");
  const row = await db.envVar.create({ data: { projectId: project.id, key: input.key, valueEnc: encryptString(input.value) } });
  await audit({ action: "env.create", teamId: team.id, actor, targetType: "env_var", targetId: row.id, meta: { key: input.key } });
  return json({ id: row.id }, 201);
});
```

- Always wrap handlers with `route()` (per-IP rate limit + uniform errors). Custom limit: `route(fn, { limit: LIMITS.deploy, key: "deploy" })`.
- Next 15: `params` is a **Promise** — `await params`.
- Never export anything else than HTTP verbs / route config (`dynamic`, `runtime`…) from a `route.ts`.
- Extra per-user throttling for mutations: `await throttle(\`deploy:${actor.user.id}\`, LIMITS.deploy)`.
- `json()` serialises BigInt as strings (e.g. `githubRepoId`).

### Response / error format

- Success: 2xx, body is the payload itself (`{ project }`, `{ items, next }`, …). Lists paginate with `{ items, next }` (cursor = last id).
- Error: `{ "error": { "code": "…", "message": "human readable", "fields"?: { "path": "message" } } }`

| helper | status | code |
|---|---|---|
| `E.bad(msg, fields?)` | 400 | BAD_REQUEST |
| `E.unauthorized()` | 401 | UNAUTHORIZED |
| `E.forbidden(msg?)` | 403 | FORBIDDEN (also CSRF from middleware) |
| `E.notFound(msg?)` | 404 | NOT_FOUND (also used for "not a member" — no existence leak) |
| `E.conflict(msg)` | 409 | CONFLICT |
| `E.validation(fields, msg?)` / ZodError | 422 | VALIDATION |
| `E.tooMany(resetIn)` | 429 | RATE_LIMITED |
| `E.unavailable()` | 503 | UNAVAILABLE |
| anything else | 500 | SERVER_ERROR (logged, never leaked) |

Client side: `api<T>(path, { method, body })` from `@/lib/client/api` throws `ApiClientError {status, code, message, fields}`.

## 3. Auth helpers

| helper | use |
|---|---|
| `requireSession()` → `{ sessionId, user }` | cookie session only (account, tokens management) |
| `requireApiTokenOrSession({ scope? })` → `Actor` | API (CLI/CI) + dashboard. Token: `Authorization: Bearer ld_…` |
| `requireTeamRole(teamIdOrSlug, min = "VIEWER", { scope?, actor? })` → `{ actor, user, team, role }` | team resources |
| `requireProjectRole(projectId, min, { scope?, actor? })` or `requireProjectRole(slug, min, { team })` → `{ …, project }` | project resources |
| `requirePlatformOwner()` | platform settings / servers |
| pages: `getTeamContext(teamSlug)`, `getProjectContext(teamSlug, projectSlug)` from `@/lib/auth/context` | server components (redirects to /login, `notFound()` for non-members, cached per request) |
| `getSession()`, `getUser()`, `requireUser(next?)` from `@/lib/auth/session` | lower level |

`Actor = { kind: "session" | "token", user, sessionId, token: { id, teamId, scopes } | null }` — pass it to `audit({ actor })`.

Roles: `VIEWER < MEMBER < ADMIN < OWNER` (`hasRole(role, min)` in `@/lib/auth/roles`). Suggested minimums:
read anything → VIEWER; deploy / env / create project → MEMBER; domains, members, project delete, databases → ADMIN; team delete/slug → OWNER.

Token scopes (checked only for tokens): `*`, `projects:read|write`, `deployments:read|write`, `env:read|write`, `domains:read|write`, `logs:read`
(`x:write` implies `x:read`). Add new scopes to `TOKEN_SCOPES` in `src/lib/auth/tokens.ts`.
Team-restricted tokens (`ApiToken.teamId`) only see their team (enforced by `requireTeamRole`).

CSRF (middleware): mutating `/api/**` requests must be same-origin, **or** carry `Authorization: Bearer`, **or** carry
neither Origin/Referer nor the session cookie (CLI). Exempt prefixes: `/api/webhooks/`, `/api/internal/`, `/api/v1/github/webhook`.
Page gate: every page except `/login /register /forgot-password /reset-password /invite /2fa` needs a session cookie.

Sessions: cookie `ld_session` (JWT HS256 with `{sid, uid}`, 30 days; the `Session` row is authoritative and cached 30 s).
2FA: login returns `{ twoFactor: true }` and sets `ld_2fa` (10 min) → `POST /api/v1/auth/2fa { code }` (TOTP or recovery code).
Current team cookie: `ld_team` (`POST /api/v1/teams/:team/switch`).

### Existing endpoints (foundation)

```
POST /api/v1/auth/{register,login,logout,2fa,forgot-password,reset-password}
GET|PATCH /api/v1/me      POST /api/v1/me/password     GET /api/v1/me/sessions   DELETE /api/v1/me/sessions/:id
POST /api/v1/me/2fa/{setup,enable,disable}
GET|POST /api/v1/teams    GET|PATCH|DELETE /api/v1/teams/:team    POST /api/v1/teams/:team/switch
GET /api/v1/teams/:team/members    PATCH|DELETE /api/v1/teams/:team/members/:userId
GET|POST /api/v1/teams/:team/invites    DELETE /api/v1/teams/:team/invites/:id
GET|POST /api/v1/invites/:token (preview / accept)
GET|POST /api/v1/tokens   DELETE /api/v1/tokens/:id      (plain token returned once)
GET /api/v1/teams/:team/audit?cursor&limit&action
GET /api/v1/deployments/:id/logs?stream=BUILD|RUNTIME[&format=json&from=&limit=&follow=0]   (SSE by default)
GET /api/health
```

## 4. Audit log

```ts
await audit({ action: "deployment.cancel", teamId, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number } });
```
Never throws. IP/UA are picked up from the request automatically (pass `ip`/`userAgent` from the worker if relevant).
Action names: `<resource>.<verb>` (`project.create`, `project.delete`, `deployment.create|cancel|promote|rollback`, `env.create|update|delete`,
`domain.add|verify|remove`, `member.role_change`, `token.create`, …).

## 5. Deployments contract (`src/lib/deployments.ts`)

```ts
createDeployment({ projectId, target: "PRODUCTION" | "PREVIEW", source?: { branch, commitSha, commitMessage, commitAuthor, commitAuthorAvatar, prNumber, uploadId, sourceDeploymentId },
                   trigger?: DeploymentTrigger, createdById?, meta?, enqueue? = true }): Promise<Deployment>
  // → row QUEUED (number = per-project sequence, shortId 9 chars, url host), DeploymentEvent, appendLog("queued"), queues.build.add({deploymentId})
setStatus(deploymentId, to, { errorMessage?, errorStep?, imageTag?, containerIds?, message?, meta? }): Promise<Deployment>
  // atomic compare-and-set; throws TransitionError when not allowed (e.g. canceled meanwhile → stop working)
cancelDeployment(deploymentId, byUserId?): Promise<Deployment>
isCancelRequested(deploymentId): Promise<boolean>     // poll between build steps; or SUBSCRIBE "ld:cancel" (payload = deploymentId)
currentProduction(projectId), markCurrentProduction(projectId, deploymentId)
deploymentHost(projectSlug, shortId)  → "{project}-{shortid}.{PLATFORM_DOMAIN}"
projectHost(projectSlug)              → "{project}.{PLATFORM_DOMAIN}"
branchHost(projectSlug, branch)       → "{project}-git-{branch}.{PLATFORM_DOMAIN}"
hostUrl(host), deploymentUrl(d), dnsLabel(s, max)
TRANSITIONS, canTransition(from, to), ACTIVE_STATUSES, FINAL_STATUSES, STATUS_CHANNEL ("ld:deployments:status" pub/sub, StatusEvent JSON)
```
Transitions: QUEUED→BUILDING|DEPLOYING|ERROR|CANCELED · BUILDING→DEPLOYING|ERROR|CANCELED · DEPLOYING→READY|ERROR|CANCELED ·
READY→SUPERSEDED|ERROR · SUPERSEDED→READY|DEPLOYING (promote/rollback) · ERROR, CANCELED final.
`setStatus` fills timestamps (buildStartedAt, buildFinishedAt, deployStartedAt, readyAt, finishedAt, duration) and enqueues
`notify` (`deployment.ready` / `deployment.error`) — the dashboard area registers the `notify` processor.
Build flow: build worker `setStatus(id,"BUILDING")` → … → `setStatus(id,"DEPLOYING",{imageTag})` → `queues.deploy.add({deploymentId:id})`.
Deploy worker: … → `setStatus(id,"READY",{containerIds})`, mark previous production `SUPERSEDED`, `markCurrentProduction`.

## 6. Queues & worker processors

Queues: `build, deploy, domains, cron, metrics, backups, cleanup, notify` (`queues.<name>.add(data, opts?)`, typed by `JobData` in `queues.ts`;
extend `JobData` additively if you need more fields). Build/deploy job ids are `build-<deploymentId>` / `deploy-<deploymentId>` (dedupe + cancel).

Register processors in **your own file** `src/worker/processors/<area>.ts`:

```ts
import { registerProcessor, registerSchedule, onWorkerStart } from "@/lib/queues";
import { setStatus, isCancelRequested } from "@/lib/deployments";
import { appendLog, endLogs, archiveLogs } from "@/lib/logs";

registerProcessor("build", async (job) => {
  const { deploymentId } = job.data;
  await setStatus(deploymentId, "BUILDING");
  await appendLog(deploymentId, "BUILD", "Cloning…");
  // …
}, { concurrency: 2, lockDuration: 30 * 60_000 });

registerSchedule("metrics", "sample-every-minute", { every: 60_000 }, { tick: true });
registerSchedule("cleanup", "nightly", { pattern: "17 3 * * *" }, { kind: "all" });
onWorkerStart("sync-routes", async () => { await syncRoutes(); });
```
One processor per queue (registering twice throws). Concurrency: option > `WORKER_CONCURRENCY_<QUEUE>` env > `WORKER_CONCURRENCY` (2).
The worker writes a heartbeat to Redis `ld:worker:heartbeat` (shown by `/api/health`). SIGINT/SIGTERM drain active jobs (60 s max).
Run: `npm run worker` (loads `.env` if present).

## 7. Logs

```ts
await appendLog(deploymentId, "BUILD", "line 1\nline 2");   // or string[]; ANSI colours are kept; lines > 8 KB truncated
await endLogs(deploymentId, "BUILD");                        // ALWAYS call when the stream is finished (success or error) → SSE `end`
await archiveLogs(deploymentId, "BUILD");                    // gzip to STORAGE_DIR/logs/<id>.log.gz (RUNTIME: <id>.runtime.log.gz) + LogArchive row; Redis key expires in 1 h
await readLogs(deploymentId, "BUILD", { from?, limit? })     // → { lines: [{id, ts, line}], next, ended, source: "live"|"archive"|"none" }
return logStreamResponse(deploymentId, "RUNTIME", { signal: req.signal, from, follow })   // SSE Response (you do the access check)
```
Live storage: Redis stream `ld:logs:<id>:<STREAM>` (capped at LOG_MAX_LINES), pub/sub `ld:logs:pub:<id>:<STREAM>` (JSON array of lines).
SSE format: `id: <streamId>` + `data: {"id","ts","line"}`; `event: end` when finished; `: ping` every 15 s; resumes from `Last-Event-ID`.
Runtime logs: the runtime area pipes container output into `appendLog(id, "RUNTIME", …)` (or serves its own SSE with the same event format,
which `<LogViewer src=…>` can consume).

## 8. Settings, crypto, env

- `await getSetting("build.proxy")`, `await setSetting("deploy.drainSeconds", 30)` — add new keys with schema + default to `SETTINGS` in `src/lib/settings.ts`.
- Secrets at rest: `encryptString` / `encryptJson` (AES-256-GCM, key from ENCRYPTION_KEY). Store in `*Enc` columns. Never log decrypted values; show `maskSecret()`.
- Tokens / invite links / reset links: store only `sha256(token)`; show the plain value once.
- `env.X` for config (validated lazily); never read `process.env` for required config in new code except in edge middleware.

## 9. UI kit (`@/components/ui`)

`Button` (variants primary|secondary|outline|ghost|danger|accent, sizes sm|md|lg|icon, `loading`, `leftIcon`), `LinkButton`, `Spinner`,
`Input` (`prefix`/`suffix`, `invalid`), `Textarea`, `Label`, `Field` (label + hint/error), `Select` (`options`), `Switch`,
`Badge` (tone neutral|outline|accent|success|warning|danger), `StatusDot` (`status` QUEUED/BUILDING/DEPLOYING/READY/ERROR/CANCELED/SUPERSEDED, `withLabel`) + `STATUS_STYLE`,
`Card`/`CardHeader`/`CardBody`/`CardFooter` (Vercel settings-card pattern: footer = hint left, action right),
`Table`/`THead`/`TBody`/`TR`/`TH`/`TD`, `NavTabs` (route tabs) / `Tabs` (segmented), `Dialog` (`open`, `onClose`, `title`, `description`, `footer`),
`Dropdown` (+ `DropdownItem`, `DropdownLabel`, `DropdownSeparator`; children may be `(close) => …`), `ToastProvider`/`useToast()` (`toast.success|error|info`),
`EmptyState`, `CodeBlock` (`prompt` for shell, `wrap`), `Code` (inline), `CopyButton`, `Skeleton`, `Breadcrumbs`, `Avatar`,
`LogViewer` (`deploymentId` + `stream`, or `src` SSE URL, or static `lines`; virtualised, ANSI, search, follow, wrap, download).
Shell (`@/components/shell/*`): `PageHeader` + `PageBody`, `AreaPlaceholder`, `TopNav`, `SubNav`, `TeamSwitcher`, `UserMenu`, `ThemeToggle`/`useTheme`,
`CommandPaletteProvider` / `useCommands([...])` (register page commands) / `openCommandPalette()` / `SearchField`.
Utils: `cn`, `timeAgo`, `formatDuration`, `formatBytes`.

## 10. Where each area plugs its pages

| route | file | owner |
|---|---|---|
| `/{team}` (projects grid — foundation version) | `src/app/(dashboard)/[team]/(team)/page.tsx` | dashboard (may replace) |
| `/{team}/new` | `…/[team]/(team)/new/page.tsx` | git+cli |
| `/{team}/members, /tokens, /audit, /settings` | `…/[team]/(team)/<name>/page.tsx` (functional foundation versions) | dashboard (polish, notifications, webhooks) |
| `/{team}/{project}` overview | `…/[team]/[project]/page.tsx` | dashboard |
| `…/deployments`, `…/deployments/[deploymentId]` | `…/[project]/deployments/**` | dashboard |
| `…/logs`, `…/domains`, `…/storage`, `…/databases`, `…/cron` | `…/[project]/<tab>/page.tsx` | runtime |
| `…/environment`, `…/settings` | `…/[project]/<tab>/page.tsx` | dashboard (git settings section by git+cli) |
| `…/ai` | `…/[project]/ai/page.tsx` | ai |
| `/account` | `src/app/(dashboard)/account/**` | foundation |

Replace the placeholder `page.tsx` entirely. Need nested routes? add folders under the tab. New project tab → add to `PROJECT_TABS`
in `src/components/shell/nav.ts` (team tabs: `teamTabs()`); also add the slug to `RESERVED_PROJECT_SLUGS` if it is a new team-level route.
Layouts already render `TopNav` + `SubNav` and enforce membership; a page starts with
`const { team, project, role, user } = await getProjectContext(params.team, params.project);` then `<PageHeader …/><PageBody>…</PageBody>`.
Mutations from pages: client component + `api()` + `router.refresh()` + `useToast()`.

## 11. Design rules

- Vercel-like, monochrome + **one accent** (blue `accent`). Status colours only for status (success/warning/danger).
- Dark is the default (`html.dark`), light via `html.light`; the theme is stored in `localStorage["ld-theme"]` (`dark|light|system`).
  Use the semantic Tailwind tokens only: `bg`, `bg-subtle`, `surface`, `surface-2`, `border`, `border-strong`, `fg`, `muted`, `subtle`,
  `accent`, `success`, `warning`, `danger` (with alpha: `bg-danger/10`). **Never** hardcode `#hex`, `gray-*`, `zinc-*` or `dark:` variants.
- Font: Geist Sans / Geist Mono (`font-sans`, `font-mono`; mono for hashes, URLs in code, logs, env keys). Base text 14px; secondary text `text-[13px] text-muted`.
- Page = `PageHeader` (28–32px semibold title, tight tracking) + `PageBody` (`container-page`, max 1200px). Settings pages: stack of `Card`s with `CardFooter` actions, max-w-3xl.
- Borders, not shadows (`shadow-pop` only for popovers/dialogs). Radius 6px controls / 12px cards. Hover = `border-border-strong` or `bg-surface-2`.
- Primary action = `variant="primary"` (inverted fg/bg), one per view. Destructive = `danger` inside a red-bordered card.
- Empty lists → `EmptyState` with a call to action; loading → `Skeleton`; feedback → `useToast()`; never `alert()`.
- Every page must work at 375px width (no horizontal page scroll; tables scroll inside their container).
- Icons: `lucide-react`, 14–16px (`h-3.5 w-3.5` / `h-4 w-4`).

## 12. Commands

```
cd control
npm install
cp .env.example .env              # dev values
npx prisma db push && npm run db:seed
npm run dev                        # http://localhost:3000  (admin@levantdeploy.local / Admin@12345)
npm run worker                     # BullMQ worker
npm run typecheck && npm test && npm run build
```
Need a change in a shared file (schema, http, queues, logs, deployments, auth, middleware)? Write `docs/requests/<area>.md`
(small additive schema fields are fine: add them, note them there, run `npx prisma db push`).
