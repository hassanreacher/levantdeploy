# builder-core — notes, contracts, signatures

Status: DONE (wave E). Everything below was verified for real (see "Verification").

Isolation: DB `levantdeploy_bcore`, `REDIS_URL=redis://localhost:6379/13`, port 3113 (`control/.env.bcore`, gitignored).

## Prisma models (pushed — additive, `prisma/schema.prisma` bottom section)

Enums: `BuilderRunStatus { QUEUED RUNNING SUCCEEDED FAILED CANCELED }`, `BuilderMessageRole { USER ASSISTANT SYSTEM }`.

### BuilderProject
| field | type | notes |
|---|---|---|
| id | cuid | workspace `STORAGE_DIR/builder/{id}/repo` |
| teamId | String → Team (cascade) | |
| projectId | String? @unique → Project (SetNull) | Deploy project, created on first publish |
| baseRef | String? | `BaseProject.ref` of the attached LevantBase backend |
| name, description?, prompt? | String | prompt = initial "what do you want to build" text |
| template | String = "next15" | |
| status | String = "DRAFT" | DRAFT \| GENERATING \| READY \| ERROR (agents set GENERATING during a run) |
| previewStatus | String = "STOPPED" | STOPPED \| STARTING \| RUNNING \| ERROR (owned by builder-core preview lib) |
| previewError?, previewStartedAt?, previewLastActiveAt? | | |
| settings | Json = {} | `{knowledge?, instructions?, theme?, model?, share?: {tokenHash, expiresAt}}` |
| lastCommit | String? | cached HEAD sha (updated by every commit via `lib/builder/git`) |
| lastDeploymentId?, lastPublishedAt? | | set by publish |
| createdById | String? → User | |
| createdAt, updatedAt | | |
Relations: `messages BuilderMessage[]`, `runs BuilderRun[]`; back-relations `Team.builderProjects`, `Project.builderProject`, `User.builderProjects`.

### BuilderMessage
`id, builderProjectId (cascade), role BuilderMessageRole, content String, attachments Json=[] ([{kind:"image"|"file"|"element", name?, url?, src?, text?}]), commitSha?, agentRunId? → BuilderRun (SetNull), authorId? → User, meta Json={}, createdAt` — index (builderProjectId, createdAt).

### BuilderRun
`id, builderProjectId (cascade), status BuilderRunStatus=QUEUED, kind String="edit" (build|edit|fix|…), prompt?, plan Json?, steps Json=[], usage Json={}, error?, baseCommit?, resultCommit?, createdById? → User, cancelRequestedAt?, startedAt?, finishedAt?, createdAt, updatedAt` — relations `events BuilderRunEvent[]`, `messages BuilderMessage[]`.

### BuilderRunEvent
`id, runId → BuilderRun (cascade), seq Int, type String (status|step|message|delta|tool_call|tool_result|commit|error|usage…), data Json={}, createdAt` — `@@unique([runId, seq])`.

(LlmUsage / AiProviderConfig belong to the llm area. builder-agents added `BuilderRun.phase` / `state` additively.)

### Additive fields added by builder-agents (please keep)
`BuilderRun.phase String?` (current orchestrator phase) and `BuilderRun.state Json?` (resumable orchestrator checkpoint — RunState in
`src/lib/builder/agents/types.ts`). builder-agents fills `steps` with the documented `[{role, title, status, startedAt, finishedAt, commitSha?}]`
array, `kind` = run mode (`build` | `chat` | `fix`), `prompt` = the user's message, `usage` = `{byProvider, total}`.

## Library signatures (`@/lib/builder` — worker-safe unless noted; barrel `src/lib/builder/index.ts`)
Workspace = `STORAGE_DIR/builder/{id}/repo` (same path builder-agents' fallback uses). Git always runs with `safe.directory=*`
(the repo is chowned to the preview uid 1000 when control runs as root).

```ts
// workspace.ts
repoDir(id): string; workspaceDir(id): string; createWorkspace(id, { template?, name? }) → { dir, sha }   // copy template + git init + commit (author "system")
deleteWorkspace(id); writeEnvLocal(id, vars) /* .env.local, gitignored, preview only */; readEnvLocalKeys(id); removeEnvLocal(id); fixOwnership(dir)
// git.ts  (author: "agent:<role>" | "system" | { name, email?, userId? })
commitAll(id, message, author, { paths?, allowEmpty? }) → sha | null          // null = nothing changed; serialized by withRepoLock(id, fn)
headSha(id) → sha | null; log(id, { limit?, before?, path? }) → CommitInfo[]; getCommit(id, ref) → CommitInfo
diff(id, ref, { against?, patches?, path? }) → FileChange[]; diffText(id, ref, opts) → string
restore(id, sha, author, message?) → { sha, changed }     // NEW commit whose tree = sha's tree ("Restore to <short>: <title>")
showFile(id, ref, path) → Buffer | null; lsTree(id, ref); archive(id, { ref?, format?: "tar.gz"|"zip"|"tar", prefix? }) → Buffer
CommitInfo = { sha, shortSha, message, title, date, author: { kind: "agent"|"user"|"visual"|"system", role, name, email }, parents }
FileChange = { path, status: "added"|"modified"|"deleted"|"renamed", additions, deletions, from?, binary?, patch? }
// files.ts  (path safety: relative, no "..", not .git/node_modules/.next/.levant, no .env*; realpath stays inside; text ≤ 1 MB, binary ≤ 5 MB)
listFiles(id, { ref? }) → [{ path, size, tracked }]; readFile(id, path, { ref? }) → { path, size, binary, encoding: "utf8"|"base64", content, truncated? }
writeFile(id, path, content, { encoding?, commit?: { message, author } }) → { path, size, commit }; deleteFile; renameFile; searchFiles(id, q)
safeRelPath(p) (throws FileError(status, msg))
// visual-edit.ts
applyVisualEdits(id, ops[], { author, message? }) → { commit, message, files, results: [{ op, src, file, newSrc?, description }] }
// structural ops (move/duplicate/delete/insert before|after) on the only child of an `asChild` element (Radix Slot,
// e.g. <Button asChild><Link/></Button>) act on the asChild parent — otherwise Slot would get 2 children
ops: setText{src,text} | setClass{src,add?,remove?,className?} (alias setClassName{src,classes}) | setStyle{src,style} | setAttr{src,name,value|null}
     | move{src,target,position:"before"|"after"} (alias beforeSrc/afterSrc) | duplicate{src} | delete{src} (alias remove)
     | insert{target,position:"before"|"after"|"inside"|"inside-start"|"inside-end",component} (alias insertComponent{targetSrc,position,componentId})
mergeClasses(existing, add[], remove[]) (tailwind conflict groups); listLibrary() (template.ts) → [{ id, name, category, description, backend? }]
// preview.ts (lifecycle runs on the worker, queue "builder-preview")
requestPreview(id, "start"|"stop"|"restart", { byUserId?, reason? })     // enqueue (dedupe bp-<action>-<id>); checks plan preview hours
startPreviewNow(id) / stopPreviewNow(id) / restartPreviewNow(id) / deletePreview(id) / stopIdlePreviews(now?)   // worker
previewState(id) → { status, host, publicUrl, error, startedAt, lastActiveAt, container }; isPreviewRunning(id); touchPreview(id, { ensureRunning? })
previewHost(id) = "preview-{id}.{PLATFORM_DOMAIN}"; containerName(id) = "lvb_{id}"; previewAlias(id) = "lvb-{id}" (levant_net, :3000)
getPreviewErrors(id, { windowMs?, limit? }) → [{ id, at, source: "server"|"runtime"|"console"|"overlay"|"unhandledrejection", message, stack?, route?, file? }]
getPreviewErrorMessages(id) → string[]          // what builder-agents' ChecksPort.previewErrors wants
getPreviewLogs(id, { tail? }) → [{ ts, line }]; recordPreviewError(id, e); clearPreviewErrors(id)
runCheck(id, "typecheck"|"lint"|"build") → { kind, ok, summary, durationMs, mode: "exec"|"oneoff", output, diagnostics: [{ file, line, col, severity, code, message, source }] }
   // exec in the running preview, else a one-off container; build = `next build` with NEXT_PUBLIC_LEVANT_EDITOR=0 into .levant/build-check
addDependency(id, ["pkg@ver"], { dev?, author?, restartPreview? }) → { ok, output, commit, restarted }
   // `lv-add` in a one-off container (own memory budget) → commits package.json + pnpm-lock.yaml → restarts a running preview
execInPreview(id, cmd[], { env?, timeoutMs?, oneOff? }) → { exitCode, output, durationMs, timedOut, mode }
issuePreviewToken(id, userId, next?) → { url, expiresIn }  // 2-min SSO link (iframe src); createShareLink(id, { ttlHours? }) → { url, expiresAt }; revokeShareLink; shareInfo
// backend.ts
attachBackend(id, { ref?, create?, userId?, restartPreview? }) → { ref, url, anonKey, status, created, envKeys }   // writes .env.local (never committed)
detachBackend(id); syncBackendEnv(id)
// publish.ts (API-only: uses the server-only base "connect" lib)
publishBuilderProject(id, actor) → { deployment, url, productionUrl, project, createdProject, commit, envKeys }; publishState(id); ensureDeployProject; uploadFromCommit
// export.ts
exportZip(id, { ref? }) → { filename, bytes }; exportToGitHub(id, { repo, private?, installationId?, description? }) → { url, repo, created, sha }
// projects.ts
createBuilderProject({ teamId, userId, name?, prompt?, template?, settings? }); startInitialRun(id, { userId, prompt, attachments? }) → { runId, error }
deleteBuilderProject(id); builderProjectDTO(row); STARTERS; nameFromPrompt(prompt)
// usage.ts: meterPreviewMinute, previewHoursUsed(teamId), previewQuotaError(teamId)   (UsageCounter resource "builder.previewHours")
// access.ts (Next-only): requireBuilder(id, minRole, scope), builderRoute(fn) (maps FileError/VisualEditError/... to API errors)
```

**For builder-agents** (replace the fallback adapters): `WorkspacePort.root → repoDir`, `head → headSha`, `commit → commitAll(id, message, author, { paths })`
(author `"agent:<role>"` or `{ name, email }`), `restore → restore(id, sha, author, message)`, `addDependency → addDependency(id, pkgs, { dev })`,
`ChecksPort.run → runCheck(id, kind)` (`{ ok, output, summary, diagnostics }`), `previewErrors → getPreviewErrorMessages(id)`,
`BackendPort.attach → attachBackend(id, { userId })` then wait for ACTIVE. "Create from prompt": `POST /api/v1/builder/projects { prompt }`
calls `startRun({ builderProjectId, userId, message, mode: "build", attachments })` from `./agents/runs` (via `startInitialRun`).

## REST API (`/api/v1/builder/**`, session or Bearer token; scopes projects:read|write; non-members → 404)
| method + path | role | body / query → response |
|---|---|---|
| GET `/projects?team=` | VIEWER | `{ items: BuilderProject[] }` (shape = `src/lib/builder-ui/types.ts`) |
| POST `/projects` | MEMBER | `{ team, prompt?, name?, template?, description?, visibility?, settings?, attachments?, run? }` → 201 `{ project, run, runError }` |
| GET / PATCH / DELETE `/projects/:id` | VIEWER / MEMBER / ADMIN or creator | PATCH `{ name?, description?, settings? (merged) }`; DELETE `?confirm=<name>` |
| GET `/templates` · GET `/components` | any | starters (gallery) · component library for "Add section" |
| GET `/projects/:id/files[?ref=]` | VIEWER | `{ items: [{ path, size, tracked }] }` |
| GET `/projects/:id/files/content?path=&ref=` | VIEWER | `{ path, size, binary, encoding, content, truncated? }` |
| PUT `/projects/:id/files/content` (also PUT `/files`) | MEMBER | `{ path, content, encoding?, message? }` → `{ file, commit }` |
| DELETE `/projects/:id/files/content?path=` · POST `/files/rename { from, to }` · GET `/files/search?q=` | MEMBER/VIEWER | commit / items |
| GET `/projects/:id/commits?limit=&before=&path=` | VIEWER | `{ items: Commit[], next }` (Commit: sha, shortSha, title, message, date, author{kind,role,name}, runId, published) |
| GET `/projects/:id/commits/:sha[?format=patch]` | VIEWER | `{ commit, files: FileChange[] (with patch) }` or text/plain diff |
| GET `/projects/:id/diff?from=&to=` | VIEWER | `{ files }` |
| POST `/projects/:id/restore { sha }` | MEMBER | `{ commit, changed }` |
| GET / POST `/projects/:id/preview` | VIEWER / MEMBER | `{ status, url (SSO iframe URL, MEMBER+), publicUrl, error, errors[], startedAt, lastActiveAt }`; POST `{ action: start|restart|stop }` → 202 |
| GET `/projects/:id/preview/url?next=` | MEMBER | `{ url, expiresIn }` (also wakes the preview) |
| GET `/projects/:id/preview/logs?tail=` · GET/POST/DELETE `/preview/errors` | VIEWER / MEMBER | dev-server lines · current errors |
| POST `/projects/:id/preview/check { kind }` | MEMBER | CheckResult (sync, ≤ 10 min) |
| POST `/projects/:id/preview/dependencies { packages, dev? }` | MEMBER | `{ ok, output, commit, restarted }` |
| POST `/projects/:id/visual-edit { ops, message? }` | MEMBER | `{ commit, results: [{ op, src, newSrc, description }], files }` |
| POST `/projects/:id/uploads` (multipart `file`, image ≤ 5 MB) | MEMBER | `{ url: "/uploads/<name>", path: "public/uploads/<name>", commit }` |
| GET / POST / DELETE `/projects/:id/share` | VIEWER / MEMBER | POST `{ enabled, ttlHours? }` → `{ url, expiresAt }` (URL shown once; default 7 days) |
| GET / POST `/projects/:id/publish` | VIEWER / MEMBER | PublishState / 201 `{ deployment, url, productionUrl, project, … }` |
| GET `/projects/:id/export.zip[?ref=]` | VIEWER | application/zip |
| POST `/projects/:id/export/github { repo, private?, installationId? }` | MEMBER | `{ url, repo, created, sha }`; 400 with a clear message when the GitHub App isn't configured/installed |
| GET / POST / DELETE `/projects/:id/backend` | VIEWER / MEMBER | POST `{ ref? , create? }` → `{ project, backend, envKeys }` |
Run endpoints (`/runs/**`) and `/messages` belong to builder-agents.

## Preview routing + gate (Caddy, additive)
`src/lib/proxy/builder.ts` (+ 3 small hooks in `config.ts` / `state.ts` / `hosts.ts`): ONE static route for all previews — Host matched by
`header_regexp` `^preview-([a-z0-9]{20,40})\.{PLATFORM_DOMAIN}(:port)?$`, upstream dial `lvb-{http.regexp.lvpreview.1}:3000` → no Caddy
resync when apps are created/deleted. `/__levant/sso|share` → `/api/internal/builder/preview-sso`, `/__levant/errors` → `preview-errors`,
everything else: forward-auth `GET /api/internal/builder/preview-auth` (Upgrade/Connection headers stripped from the auth sub-request only —
otherwise HMR websockets get a 502) → `reverse_proxy` with `flush_interval -1` (HMR websocket verified through Caddy). Upstream errors on
preview hosts → `/api/internal/builder/preview-page` ("Starting the preview…", auto-refresh, start enqueued). tls-ask allows preview hosts of
existing builder projects. `BUILDER_PREVIEWS=off` removes the route.
Cookie `__levant_preview` (HMAC, 12 h, host-only, HttpOnly; https: `SameSite=None; Secure; Partitioned` so it works inside the editor iframe;
http: `SameSite=Lax`). Members need MEMBER+ (re-checked every 30 s); share-link cookies die when the link is revoked/replaced.

## Template `builder-template/next15` + runtime image
- Next 15.5.27 / React 19.1.1 / TS 5.9.3 strict / Tailwind 3.4.19 (shadcn new-york, CSS variables) / lucide 0.468 / pnpm 9.15.9, all pinned;
  25 shadcn/ui components pre-generated (accordion, alert, avatar, badge, button, card, checkbox, dialog, dropdown-menu, form, input, label,
  navigation-menu, popover, progress, select, separator, sheet, skeleton, sonner, switch, table, tabs, textarea, tooltip);
  `lib/supabase.ts` (browser client, null-safe) + `lib/supabase-server.ts` (cookies-bound SSR client); `.prettierrc.json` (printWidth 160 →
  visual edits produce 1-line diffs); isolated pnpm linker (`.npmrc`).
- Source mapping: `levant/lv-src-loader.cjs`, a webpack pre-loader added by `next.config.mjs` ONLY when `NEXT_PUBLIC_LEVANT_EDITOR=1` and `dev`
  (SWC stays the compiler). `env.NEXT_PUBLIC_LEVANT_EDITOR` is always inlined ("0" in production) → the bridge is dead-code-eliminated.
  Tags host elements and Capitalized components (props spread → the usage site wins), skips fragments / member expressions.
- Bridge (`components/levant/bridge.tsx`) protocol = builder-ui's `src/lib/builder-ui/bridge.ts` (`__lv: 1`) plus the spec fields:
  bridge → editor `ready | hover{el} | select{el, src, tag, text, classes, rect} | deselect | text{src, text, previous} |
  move{src, target, position, beforeSrc|afterSrc} | error{message, stack, source, route} | navigate{path} | pong`; editor → bridge
  `mode{enabled}|mode{mode} | select{src} | editText{src} | applyClass{src, add, remove} | applyStyle{src, style} | applyAttr | navigate | reload | ping`.
  Edit mode by default only when framed. Errors also POSTed to `/__levant/errors` (stored for agents even without an editor open).
- Library `builder-template/library/*.tsx` + `index.json` (navbar, hero, features, stats, pricing, testimonials, team, gallery, blog-list, faq,
  cta, contact-form (supabase insert into `contact_messages`, SQL in the file), auth-forms, footer) — all typecheck + lint in the template.
- Runtime image `levant/builder-runtime:next15` (node:22-slim, non-root `node`, template deps in `/opt/levant/base/node_modules` hard-linked to
  the pnpm store `/opt/levant/store` → `lv-add` only downloads new packages). 258 MB compressed. Build: `builder-template/runtime/build.sh`
  (`HTTPS_PROXY`/`NO_PROXY` build args + `LEVANT_CA=<pem>` BuildKit secret + `NODE_IMAGE=mirror.gcr.io/library/node:22-slim`).
  Container: repo bind-mounted at /app (uid 1000), entrypoint links node_modules and installs only when deps/lockfile changed
  (dep fingerprint, not the whole package.json), `next dev -H 0.0.0.0 -p 3000`, 2 GB / 2 CPU, cap-drop ALL, no-new-privileges.

## Env (all optional)
`BUILDER_TEMPLATE_DIR` (default `<cwd>/../builder-template`, `/app/builder-template` in the control image → **ops: copy builder-template/ into
the control image**), `BUILDER_RUNTIME_IMAGE` (levant/builder-runtime:next15), `BUILDER_PREVIEW_IDLE_MIN` (20), `BUILDER_PREVIEW_REMOVE_AFTER_H`
(24, stopped containers are removed), `BUILDER_PREVIEW_MEMORY_MB` (2048), `BUILDER_PREVIEW_CPUS` (2), `BUILDER_PREVIEW_UID/GID` (1000),
`BUILDER_HOST_STORAGE_DIR` (host path of STORAGE_DIR when control runs in a container), `BUILDER_EGRESS_PROXY` / `BUILDER_EGRESS_NO_PROXY` /
`BUILDER_EGRESS_CA_FILE` (fallbacks: BASE_EGRESS_*, then `build.proxy` unless it points at loopback), `BUILDER_PREVIEWS=off`.

## Shared-file changes (all additive)
- `prisma/schema.prisma`: builder models + back-relations on User/Team/Project.
- `src/lib/queues.ts`: queue `"builder-preview"` + JobData. Worker processor: `src/worker/processors/builder-core.ts` (start/stop/restart,
  idle-check every minute incl. metering + orphan cleanup scoped by a `levant.instance` label, reconcile on start).
- `src/lib/proxy/{config,state,hosts}.ts`: hooks for `./builder.ts` (see above). `src/lib/proxy/builder.ts` is new.
- `next.config.mjs`: `serverExternalPackages` += prettier, recast, @babel/parser. `package.json`: @babel/parser 7.29.9, @babel/types 7.29.8,
  recast 0.23.21, prettier 3.6.2 (exact). `.gitignore`: `storage-*/`.
- Plans: preview minutes metered into `UsageCounter` resource `builder.previewHours`; `limits.builder.previewHoursMonth` enforced on start.

## Notes for other areas
- **builder-ui**: the dashboard CSP (`next.config.mjs` `default-src 'self'`) has no `frame-src` → the preview iframe is blocked until you add
  `frame-src {scheme}://preview-*.{PLATFORM_DOMAIN}` (CSP wildcard `*.{domain}` works). Use `GET …/preview` `url` (SSO) as iframe src; it
  expires in 2 min (fetch a fresh one on reload). Over plain http dev (localhost ↔ *.levant.localhost is cross-site) the Lax cookie won't be
  sent inside an iframe — use https (Partitioned cookie) or open the preview in a tab.
- **ops/runtime**: containers from other control planes on the same Docker daemon are left alone (instance label). Don't run builder
  previews with `PROXY_TLS=off` behind TLS-terminating proxies without `X-Forwarded-Proto` (cookie Secure flag).
- **base-runtime**: Studio's forward-auth has the same websocket caveat (Upgrade headers reach control) if Studio ever needs websockets.

## Verification (sandbox, own Caddy `bcore-caddy` :8113 / admin :2113, worker on Redis 13)
1. Created an app from the template via API → preview container `lvb_<id>` RUNNING in ~10 s.
2. Through Caddy: no cookie → 401 sign-in page; SSO link → 303 + cookie → page with 147 `data-lv-src` attributes; HMR websocket 101.
3. Browser (Playwright): bridge selection overlay + `select` message, inline text edit → `text` message → persisted; every op via
   `POST /visual-edit` applied by HMR in 0.25–1 s without a reload (setText, setClass, setAttr+setStyle, move, duplicate, delete,
   insert Pricing); restore of an older commit → page back to the template. History shows `[visual]`/`[user]`/`[system]` commits.
4. Runtime errors: a broken edit produced both a browser error (bridge → `/__levant/errors` through Caddy) and a server error in `getPreviewErrors`.
5. `runCheck`: typecheck/lint pass (≈4 s/2 s), injected type error → TS2322 diagnostic with file/line/col; `next build` check fails/passes accordingly.
6. `addDependency(date-fns@4.1.0)` → one-off `pnpm add` (15 s) → commit → preview restarted → entrypoint installs (+1 package, 1.4 s; container layer 38 MB).
7. Publish → new Deploy project `bakery-demo`, upload from `git archive HEAD`, build + deploy workers → READY in 50 s (82 MB image);
   production page has 0 `data-lv-src` and no bridge code in any JS chunk.
8. ZIP export (52 entries, no node_modules/.env.local); share link redeem → 200, revoke → 401; GitHub export without an App → clear 400.
9. Idle stop (simulated +21 min) stopped the container; the next request got the "Starting…" page and the preview was back in ~2 s.
10. Backend: `POST /backend {create:true}` created a LevantBase project (attached to the Deploy project), wrote `.env.local` (not committed),
    restarted the preview. Full provisioning to ACTIVE was not completed: the sandbox disk ran out (other areas' stacks), so I removed it.
Screenshots: `docs/screenshots/builder-core/01…09`. Tests: `src/lib/builder/{visual-edit,core}.test.ts` (42 tests); full suite + tsc green.

## Follow-ups from builder-agents (done)
1. Lint ignores `.levant/**` (template `eslint.config.mjs`) and `runCheck("lint")` passes `--ignore-pattern .levant/** .next/** out/**`, so existing workspaces are covered too.
2. One-off check containers reinstalled because the old entrypoint compared the whole package.json (createWorkspace renames the package). Since the
   current image (rebuild of 16:40), the entrypoint compares a dependency fingerprint (deps/devDeps/optional/pnpm) + the lockfile; when deps really
   differ it installs only the delta from the image's pnpm store (isolated linker). Measured on a fresh workspace, one-off: typecheck 3.6 s, lint 2.4 s, build 12 s, no reinstall.
   **Rebuild/pull `levant/builder-runtime:next15` if your daemon still has an older image** (`builder-template/runtime/build.sh`); running previews are recreated automatically when the image ID changes.
3. `createBuilderProject` calls `assertCanCreateBuilderProject(teamId, { userId })` (plans) before creating anything.
