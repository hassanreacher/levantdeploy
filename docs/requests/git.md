# git+cli area — notes, contracts & requests

Status: DONE (wave B). Screenshots: `docs/screenshots/git/`. Tests: `src/lib/{github,git,uploads}/*.test.ts`, `cli/test/`, e2e `control/tests/git/e2e.ts`.

## Changes to shared files (all additive)

| file | change |
|---|---|
| `prisma/schema.prisma` | `Project.gitSettings Json @default("{}")` — HTTPS token (encrypted), deploy hooks (tokens encrypted), polling state. |
| `src/lib/queues.ts` | new queue `git` + `JobData.git` (`poll`, `poll-project`, `pr-closed`, `uploads-expire`). Processor: `src/worker/processors/git.ts`. |
| `src/lib/deployments.ts` | one line in `setStatus()`: `void emitStatusChange(updated, cur.status)` (fire-and-forget, never blocks/fails a transition). |
| `src/lib/hooks.ts` (new) | tiny registry: `onStatusChange(fn)` / `emitStatusChange()`; lazily loads `@/lib/github/status` in every process. |
| `src/lib/settings.ts` | `uploads.retentionDays` (30). `uploads.maxSizeMb` is used (capped at 2047 MB because `Upload.size` is an Int). |
| `src/middleware.ts` | CSRF exempt + `/api/v1/webhooks/` and `/api/v1/deploy-hooks/` (both authenticate themselves: HMAC / secret URL; no cookies). |
| `next.config.mjs` | CSP `form-action 'self' https://github.com` (or `GITHUB_WEB_URL`) — the GitHub App manifest flow POSTs a form to github.com. |
| `src/components/ui/input.tsx` | `InputProps` omits the HTML `prefix` attribute (it collided with the ReactNode `prefix` prop → TS errors for every `prefix={<Icon/>}`). |
| `.gitignore` (control) | `.env.*` / `!.env.example` (per-area env files). |
| ops: `src/app/(dashboard)/settings/sections.ts` (new) | **bug fix**: `SETTINGS_SECTIONS` moved out of the `"use client"` `settings-nav.tsx` — the server layout received a client reference instead of an array → every `/settings/*` page 500'd. Added the "GitHub" section + `settings/github/page.tsx`. |

## For the build area
- `src/lib/git/auth.ts` exports `getGitAuth: GitAuthProvider` exactly as requested in build.md:
  GITHUB → `{ auth: {kind:"token", token: <installation token>, username:"x-access-token"}, url: https://github.com/{full}.git }`;
  GIT + SSH URL → `{ auth: {kind:"ssh", privateKey} }`; GIT + stored token → `{ auth: {kind:"token", …} }`; else `{kind:"none"}` / null.
  Verified: builds of GitHub-sourced deployments cloned from the fake GitHub (smart HTTP + token) and of file:// Git projects succeeded through your engine.
- Uploads: dashboard folders are packed to `.tar.gz` in the browser; `.zip`/`.tar.gz`/`.tgz`/`.tar` archives are uploaded as-is (magic-checked). CLI uploads `.tar.gz`.
- Templates = `examples/*` (found via `TEMPLATES_DIR`, `../examples` or `./examples`); a template import packs the folder into a COMPLETE Upload → normal upload build.
- Import uses your `detect()` (adapter `src/lib/git/detect.ts`, shallow clone for GitHub/Git URLs) and `FRAMEWORK_PRESETS` for the preset select; falls back to "auto".

## For the runtime area
- PR closed / branch deleted → `git` job → `stopPreviews()` → your `stopDeployment(id, {reason})` (fallback: docker stop by `levant.deployment` label + `stoppedAt`).
- Deploy hooks / polling create normal deployments via `createDeployment` (trigger `API` / `GIT_PUSH`).

## For the dashboard area
- `<GitSettings projectId teamSlug canEdit />` is mounted at `settings/git` — thanks.
- Please omit `gitSettings` from `projectView()` in `GET/PATCH /api/v1/projects/:id` (values are encrypted, but nothing there is needed by the UI; `GET /api/v1/projects/:id/git` is the public view).
- Deployment `meta` keys written by this area: `source` (`github` | `git-poll` | `upload` | `template` | `image`), `prTitle`, `githubDeploymentId`, `deployHook`, `cli`, `dirty`, `firstDeployment`.

## For ops
- Control image needs the `git` binary (ls-remote, detection clones) and `openssh-client` (SSH deploy keys); `examples/` must be shipped (or `TEMPLATES_DIR`).
- Env (optional): `GITHUB_API_URL` / `GITHUB_WEB_URL` (GitHub Enterprise; tests point them at a fake), `GIT_ALLOW_HTTP=1` (allow plain http Git URLs in production), `GIT_ALLOW_FILE_URLS=1` (tests only — never in production), `GITHUB_APP_*` (alternative to the manifest flow).
- The GitHub App webhook URL is `{APP_URL}/api/v1/webhooks/github` and must be reachable from github.com.
- CLI: `cd cli && npm ci && npm run build` → `node cli/dist/index.js` (bin `levant`); publishable as the `levant` npm package.

## APIs (git+cli)

```
GET|POST|DELETE /api/v1/github/app                  status · manual credentials (verified via GET /app) · remove        (owner)
GET  /api/v1/github/app/manifest?org&team            {action, manifest} for the "Create GitHub App" form POST           (owner)
GET  /api/v1/github/app/callback?code&state          manifest conversion → creds stored encrypted → redirect to install
GET  /api/v1/github/install?team                     302 → github.com/apps/<slug>/installations/new?state
GET  /api/v1/github/callback?installation_id&state[&code]  links the installation to the team (OAuth ownership check, else owner only)
GET  /api/v1/github/installations?team               GET /api/v1/github/repos?installationId&q    GET /api/v1/github/repos/detect?installationId&repo&branch&rootDirectory
POST /api/v1/webhooks/github                         X-Hub-Signature-256, idempotent by X-GitHub-Delivery (7 d)
GET|POST /api/v1/projects                            list (team) · create/import {name, source:{github|git|upload|image|template|none}, framework, rootDirectory, buildSettings, env[], deploy}
GET|PATCH /api/v1/projects/:id/git                   view · branch/autoDeploy/previews/token/polling/connect/disconnect (ADMIN)
POST /api/v1/projects/:id/git/deploy {branch}        POST /api/v1/projects/:id/git/poll        POST /api/v1/projects/:id/git/deploy-key (rotate)
GET|POST /api/v1/projects/:id/git/hooks              DELETE /api/v1/projects/:id/git/hooks/:hookId
POST /api/v1/deploy-hooks/:projectId/:token          (unauthenticated, secret URL) → {job:{deploymentId,url,state,inspect}}
POST /api/v1/git/inspect {url, token?, deployKeyId?} → branches, default branch, detection        POST /api/v1/git/deploy-keys → pending ed25519 key (2 h)
GET  /api/v1/templates
POST /api/v1/uploads {team|projectId, size, sha256?, chunkSize?}   GET /api/v1/uploads/:id (resume)   PUT /api/v1/uploads/:id/chunks/:i   POST /api/v1/uploads/:id/complete {sha256}
POST /api/v1/uploads/:id/deploy {projectId, target, branch?, commitSha?, commitMessage?, meta?}
POST /api/v1/cli/login · POST /api/v1/cli/login/poll · GET|POST /api/v1/cli/login/:code  (+ page /cli/authorize?code=)
```

GitHub reporting (`src/lib/github/status.ts`, via the hook registry): commit status `LevantDeploy – <project>`, GitHub Deployment +
statuses (`Production` / `Preview – <project>`, transient previews, environment_url when READY), one PR comment per PR updated in place
(one row per project, "Visit Preview" when ready; newest deployment of the PR wins).

Routing rules (`src/lib/github/routing.ts`, unit tested): push to productionBranch → PRODUCTION; other branches → PREVIEW (if previews on);
PR opened/synchronize/reopened/ready_for_review → PREVIEW with prNumber (push + PR for the same commit → one deployment, tagged with the PR);
closed → stop previews; branch delete / `delete` event → stop branch previews; forks never auto-deployed; `[skip ci]`, `[ci skip]`,
`[skip deploy]`, `[deploy skip]`, `[skip levant]` skip; paused / autoDeploy off skip; installation events upsert/suspend/delete rows.

## Testing
- `npm test` (control): webhook signature (incl. GitHub's documented test vector), routing, PR comment rendering, URL parsing/option injection,
  ed25519 OpenSSH key round-trip + sign/verify, polling diff, tar writer (GNU tar lists/extracts, PAX long names), browser ignore matcher.
- `cd cli && npm test`: packing ignore rules (defaults, .gitignore incl. negation & nested files, .levantignore re-include), tarball contents, flags.
- e2e (57 checks, all passing) against :3103 with a fake GitHub (REST + JWT verification + `git http-backend`):
  `npx tsx tests/git/e2e.ts setup` → start `tests/git/fake-github.ts` → `npx tsx --env-file=.env.git tests/git/e2e.ts run`.
- CLI against :3103: `login` (device flow, approved in the page), `whoami`, `deploy --yes --env` (examples/static-html copy: project created,
  4 files packed — node_modules/.env skipped, upload stored, deployment created), `deploy --prod` streamed the live BuildKit log to
  "Image built" (status DEPLOYING — runtime's deploy processor was intentionally not run to keep away from the shared Caddy), `ls`,
  `env ls/add/rm/pull`, `logs`, `domains ls/add/verify/rm`, `rollback`.

## Known limitations
- SSH deploy keys: generation/format unit-tested and passed to the build area; no SSH clone was exercised (no ssh client/server in the sandbox).
- Polling deployments carry the sha only (no commit message/author — ls-remote doesn't provide them).
- Fork PRs are skipped (their code would see preview env vars); GitHub Checks API is not used (commit statuses + Deployments are).
- Framework detection for uploads happens at build time ("Auto-detect" in the import form).
