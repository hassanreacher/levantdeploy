# Dashboard area — notes & requests

## Shared-file changes (small, additive)

- **prisma/schema.prisma**
  - `NotificationType` gained `DISCORD`.
  - `Project.protection Json @default("{}")` — deployment protection settings (see below).
  - New model `UserNotification` (in-app bell inbox; `@@unique([userId, dedupeKey])`) + `User.inbox` relation.
- **src/components/shell/top-nav.tsx**: mounts `<NotificationBell />` (from `src/components/dashboard/notification-bell.tsx`) next to the search trigger.
- **src/components/shell/nav.ts**: team tabs `Activity` and `Usage` (`/activity`, `/usage` are already in `RESERVED_PROJECT_SLUGS`).
- **src/components/shell/command-palette.tsx**: optional `searchUrl` prop → remote results (`{ items: CommandItem[] }`) merged while typing. The team layout passes `/api/v1/teams/:team/search` (deployments by short id / commit / branch / message).
- **src/app/(dashboard)/[team]/layout.tsx**: wraps everything in `<TeamEventsProvider>` (one SSE connection per tab) and adds recent deployments + actions to the palette.
- **next.config.mjs**: `distDir: process.env.NEXT_DIST_DIR || ".next"` so several dev servers can run from one checkout (two agents sharing `.next` corrupted each other's chunks). **tsconfig.json**: `.next-*` excluded. Note: `next dev` with a custom distDir appends `.next-<x>/types/**/*.ts` to tsconfig `include` — harmless (excluded), the lead may drop those lines before shipping.
- **src/components/ui/log-viewer.tsx** (foundation UI kit, additive): if the SSE stream hasn't opened after 5 s, the viewer closes it and polls `GET …/logs?stream=…&format=json&from=` every 2 s until `ended` (archived logs end immediately). Reason: browsers allow ~6 HTTP/1.1 connections per host; with several dashboard tabs open (each holding SSE streams) a new EventSource can stay queued forever ("Connecting…"). The team-events stream (`TeamEventsProvider`) is also closed while a tab is hidden and resynced when it becomes visible. Behind Caddy with HTTP/2 the limit doesn't apply.
- **GET/PATCH /api/v1/projects/:id** never return `gitDeployKeyEnc`, `gitSettings` (git area request) or the protection password hash.
- **.gitignore**: `.env.*` (except `.env.example`), `.next-*/`.

## For the runtime / proxy area

1. **Deployment protection** is stored in `Project.protection` (written by `PATCH /api/v1/projects/:id { protection: { mode, scope, username?, password? } }`, ADMIN):
   ```jsonc
   { "mode": "none" | "password" | "basic", "scope": "previews" | "all", "username": "levant", "passwordHash": "<bcrypt, cost 10>", "updatedAt": "ISO" }
   ```
   Please apply it in `syncRoutes()`: `scope: "previews"` → preview deployment URLs + `{project}-git-{branch}` hosts; `"all"` → also production/custom domains.
   `basic` → Caddy `basic_auth` handler (`{ "accounts": [{ "username", "password": base64(passwordHash) }] }` — Caddy accepts bcrypt).
   `password` → a small password page that sets a signed cookie (7 days suggested) after `bcrypt.compare`. Helper: `readProtection(project.protection)` in `src/lib/dashboard/protection.ts`.
2. **Screenshots** (optional): the overview/detail preview shows `deployment.meta.screenshot` (an image URL/path) when present, else a browser-frame with the site's favicon (https only — dashboard CSP). If you capture screenshots after READY, store them and set `meta.screenshot`.
3. **Env vars for containers**: `resolveEnv(projectId, target, branch)` in `src/lib/dashboard/env-vars.ts` (worker-safe) merges linked shared env groups < project vars < branch-specific preview vars. Build + runtime should use it.
4. Project delete (`DELETE /api/v1/projects/:id?confirm=<slug>`) deletes the rows, then enqueues `cleanup { kind: "all", projectId }` — please make sure cleanup removes containers/images/volumes by the `levant.project=<id>` label even when the project row is gone.
5. Buttons wired to your endpoints: `POST /api/v1/deployments/:id/{promote,rollback,restart,stop}` and `POST /api/v1/projects/:id/scale { replicas }`. A 404 from them shows a graceful "not available yet" toast.
6. Runtime logs: the deployment page's "Runtime Logs" tab uses `<LogViewer stream="RUNTIME">` (foundation SSE); "Open in Logs" links to `…/logs?deploymentId=<id>`.

## For the build area

- `POST /api/v1/deployments/:id/redeploy { useCache: false }` sets `deployment.meta.noCache = true` → please build with `--no-cache` when set.
- `POST /api/v1/projects/:id/deployments { target?, branch?, commitSha? }` ("Deploy" button) creates a deployment with only `branch` (and optionally sha) — resolve the latest commit of the branch when `commitSha` is null.
- `BuildSettingsForm` is mounted at `/{team}/{project}/settings/build`.

## For git+cli

- `GitSettings` is mounted at `/{team}/{project}/settings/git` with `canEdit = ADMIN`.
- CLI endpoints you can use: `GET /api/v1/projects/:id/env` (JSON, values of non-secret vars for MEMBER+), `GET /api/v1/projects/:id/env?format=dotenv&target=DEVELOPMENT` (`levant env pull`; secrets only for ADMIN), `POST /api/v1/projects/:id/env { items | dotenv, targets, isSecret, branch, overwrite }`, `DELETE /api/v1/projects/:id/env/:envId`.

## API added (all `route()`-wrapped, session or Bearer token)

```
GET    /api/v1/projects/:id                       PATCH (general/build/runtime/protection)   DELETE ?confirm=<slug>
POST   /api/v1/projects/:id/transfer { team }
GET    /api/v1/projects/:id/deployments?cursor&limit&target&branch&status=READY,ERROR&q    POST { target?, branch?, commitSha? }
GET    /api/v1/deployments/:id                    → { deployment, events, aliases, project }
POST   /api/v1/deployments/:id/redeploy { useCache?, target? }      POST /api/v1/deployments/:id/cancel
GET|POST /api/v1/projects/:id/env                 PATCH|DELETE /api/v1/projects/:id/env/:envId   GET …/:envId/reveal (secrets: ADMIN, audited)
POST   /api/v1/projects/:id/env-groups { groupId }   DELETE /api/v1/projects/:id/env-groups/:groupId
GET|POST /api/v1/teams/:team/env-groups           GET|PATCH|DELETE …/:groupId    POST …/:groupId/vars   PATCH|DELETE …/vars/:varId
GET|POST /api/v1/teams/:team/notifications        PATCH|DELETE …/:id             POST …/:id/test
GET    /api/v1/teams/:team/events[?projectId]     SSE `event: status` (StatusEvent JSON) from STATUS_CHANNEL, filtered to the team
GET    /api/v1/teams/:team/search?q=              palette search
GET    /api/v1/me/notifications?limit&unread      POST /api/v1/me/notifications/read { ids? }
```

## Notifications (`src/worker/processors/notify.ts`, `src/lib/dashboard/notify.ts`)

On `deployment.ready` / `deployment.error` (enqueued by `setStatus`): every enabled channel of the team (team-wide or scoped to the project) subscribed to the event, every enabled outgoing `Webhook` row, and an in-app notification for each team member (idempotent). Channel failures are stored in `lastError` and don't fail the job (no duplicate re-sends).
Webhook signature: `X-Levant-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, plus `X-Levant-Event`, `X-Levant-Delivery`. Telegram uses the Bot API `sendMessage` (HTML), Slack Block Kit, Discord embeds, email via `sendMail()`.
Note: Node's `fetch` doesn't use `HTTPS_PROXY`; in this sandbox external channels (Slack/Telegram) fail with `fetch failed`, local webhooks work. Real servers are fine.

## Demo data

`npx tsx --env-file=.env scripts/seed-dashboard-demo.ts` (after `npm run db:seed`) — 6 projects, ~80 deployments with events and build logs, env vars, shared groups, domains, 30 days of hourly metrics, channels, inbox. Re-runnable (deletes and re-creates the demo projects of team `/admin`).
