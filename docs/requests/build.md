# Build area — notes & contracts (wave B)

Owned: `src/lib/build/**`, `src/lib/sources/**`, `src/worker/processors/build.ts`, `src/app/api/v1/projects/[id]/{build-settings,detect}`,
`src/components/project/BuildSettingsForm.tsx`, `src/app/(dashboard)/[team]/[project]/settings/build/page.tsx` (mounts the form),
`examples/**`, `scripts/build-examples.ts`.

## Shared-file changes (additive)
- `src/lib/settings.ts`:
  - `build.proxy` gained `network?: "host" | "default"` (docker build `--network`).
  - new key `build.registryMirror: string | null` (Docker Hub pull-through mirror for **generated** Dockerfiles' base images,
    e.g. `mirror.gcr.io` → `FROM mirror.gcr.io/library/node:22-alpine`). Useful when Docker Hub rate-limits (429) a server's IP.
- `control/.gitignore`: `.env.*` (+ `!.env.example`) so per-area env files are not shipped.

## For runtime (deploy worker)
After a successful build the deployment is `DEPLOYING` with `imageTag` and `meta.build` (`BuildMeta` in `src/lib/build/types.ts`):
```
meta.build = { framework, frameworkName, kind: WEB|WORKER|STATIC|COMPOSE, strategy: generated|dockerfile|compose|image,
               port, exposedPorts?, imageTag, imageSize, durationMs,
               // COMPOSE only:
               composeFile, composePrimary, compose: [{ name, image, built, ports }], composeSpecEnc }
```
- Generated images listen on `0.0.0.0:$PORT` (default = `meta.build.port`); **set `PORT=<project.port>`** in the container env. STATIC sites are
  served by Caddy inside the image (also `$PORT`) — treat them like WEB. Images run as non-root; prefer `--init` (`HostConfig.Init: true`).
- Repo Dockerfiles: `meta.build.port` = first `EXPOSE` (fallback detected port). PORT is still passed.
- COMPOSE: `decryptJson(meta.build.composeSpecEnc)` = the `docker compose config` normalized spec with `build:` removed and `image:` set to the
  built tags (`levant/<projectId>:<shortId>-<service>`). It contains env values (hence encrypted). `composePrimary` receives HTTP traffic;
  `imageTag` on the deployment = primary service image. Relative bind mounts were resolved to the (deleted) work dir — ignore/replace them.
- Image naming: `levant/<projectId>:<deploymentShortId>`, labels `levant.managed/project/deployment/team/framework`. Cleanup can
  `docker image rm` by repo `levant/<projectId>`.
- `IMAGE` projects: build step only pulls `project.image` and sets `imageTag = project.image`.
- Runtime env: reuse `resolveEnv(dep, project)` / `systemEnv(dep, project)` from `@/lib/build/env` (same precedence + `LEVANT_*` vars:
  LEVANT, LEVANT_ENV, LEVANT_TARGET_ENV, LEVANT_URL, LEVANT_DEPLOYMENT_URL, LEVANT_PROJECT_PRODUCTION_URL, LEVANT_BRANCH_URL,
  LEVANT_GIT_COMMIT_SHA/REF/MESSAGE/AUTHOR_NAME, LEVANT_GIT_PULL_REQUEST_ID, LEVANT_GIT_PROVIDER/REPO_OWNER/REPO_SLUG, LEVANT_DEPLOYMENT_ID, LEVANT_PROJECT_ID).

## For git+cli
- Credentials: `src/lib/git/auth.ts#getGitAuth` is lazily imported by `src/lib/sources/git-auth.ts` (thanks!). `registerGitAuthProvider(fn)`
  also works. Tokens go through `GIT_CONFIG_*` → `http.extraHeader` (never argv / .git/config / logs); SSH keys → 0600 temp file + GIT_SSH_COMMAND.
- Uploads: `Upload.path` (relative to STORAGE_DIR), tar / tar.gz / zip sniffed by magic bytes; a single top-level folder is hoisted
  (zipballs) unless `rootDirectory` points inside it. Limits: 2 GiB extracted, 200k entries, 1 GiB per file; `..`, absolute paths,
  links escaping the root, writes through symlinks are rejected; devices/fifos skipped.
- A deployment with `uploadId` (or whose `sourceDeploymentId` has one) builds from the upload even for git projects.
- Detection helper for the import flow: `detect(dir, settings, { repoDir })` and `detectPreview(project, …)` in `@/lib/build/preview`.

## For dashboard
- Settings → Build & Development: `settings/build/page.tsx` now mounts `<BuildSettingsForm projectId canEdit />`.
- `GET|PUT /api/v1/projects/:id/build-settings` (PUT replaces `buildSettings`, validated by `buildSettingsSchema`; optional `rootDirectory`).
  Your `PATCH /projects/:id { buildSettings }` merge still works, but it skips validation — prefer the PUT.
- `POST /api/v1/projects/:id/detect` (JSON `{ buildSettings?, rootDirectory? }` → latest source; or raw tar/zip body ≤ 100 MB)
  → `{ detection, summary, dockerfile, source, rootDirectories }`.
- Mobile: the settings `SettingsShell` (horizontal settings nav at < md) widens the page to ~750px at 375px width (same on the General
  page) — the nav row needs `overflow-x-auto` / `min-w-0` on the grid.
- The deployment page's LogViewer stayed on "Connecting" in my dev server for a finished build while
  `GET /api/v1/deployments/:id/logs?format=json` returned the lines — worth a look (SSE in dev?).

## Build settings added in the follow-up round
- `dockerfileInline` (string ≤ 64 KB, must start with FROM/ARG/comments): written to the work dir and used with the root directory as
  context; takes precedence over the repo Dockerfile and the templates. UI: Settings → Build & Development → Advanced → Inline Dockerfile.
- `systemPackages` (string[] ≤ 50, validated names): installed right after every `FROM` of generated Dockerfiles (build + runtime stages):
  `apk add --no-cache …` on Alpine images, `apt-get install --no-install-recommends …` on Debian/Ubuntu ones (through the build proxy).
  UI: Advanced → System packages. (Untestable in this sandbox: its egress policy returns 403 for dl-cdn.alpinelinux.org / deb.debian.org.)
- `Deployment.meta.noCache === true` (dashboard "redeploy without cache") → `docker build --no-cache`, no `--cache-from`
  (BuildKit cache *mounts* — npm/pip/… download caches — are still used, they only speed up downloads).
- Deploy button / API deployments with a `branch` but no `commitSha`: the engine resolves the head with `git ls-remote` first (clone pinned
  to that sha; unknown branch = SOURCE error) and records `commitSha`, `commitMessage`, `commitAuthor` on the deployment after the clone.
  Helper: `resolveRemoteRef(url, ref, auth)` in `@/lib/sources/git`.

## Detected kind is authoritative (ops full-stack finding)
- After a build, `syncProjectFromBuild()` updates `Project.kind` / `Project.framework` from `meta.build` when the project's framework
  preset is on auto (a user-chosen WORKER is kept unless the build is COMPOSE).
- **Runtime edit (additive, noted here):** `src/lib/runtime/deploy.ts` → `load()` and `removeDeploymentContainers()` use
  `effectiveKind(dep.meta, project.kind)` (`@/lib/build/types`): `meta.build.kind` wins (COMPOSE ⇄ single image, WORKER), so a deployment runs
  as what it was built as even if the project kind is stale or the preset is forced.
- Verified with `scripts/build-examples.ts --deploy compose-app` (engine + runtime `runDeploy`, isolated DB/Redis, Caddy unreachable):
  READY with 2 containers (web + redis), project kind → COMPOSE; and with a forced preset (project kind kept WEB): READY, 2 containers.

## Platform Settings → Build (`/settings/build`, owner only)
- Page `src/app/(dashboard)/settings/build/{page.tsx,build-client.tsx}` (replaces the ops slot): build proxy (HTTPS/HTTP proxy,
  no-proxy, network host|default, "use the server's proxy"), custom CA (parsed list: CN, fingerprint, expiry), Docker Hub mirror,
  read-only build limits linking to Limits (ops owns concurrency/timeout editing).
- API `GET|PUT /api/v1/platform/build` (`requirePlatformOwner`): proxy passwords are masked in GET (`user:••••@`) and a masked value sent
  back keeps the stored one; CA must parse as X.509 (≤ 256 KB); `{ proxy: null }` disables the proxy. Audit `platform.build_settings`.
- Helpers: `@/lib/build/platform` (`platformBuildView`, `savePlatformBuild`, `parseCaBundle`, `maskProxyUrl`).

## Build engine summary
`buildDeployment(id, { enqueueDeploy?, signal?, timeoutMs?, keepWorkDir? })` (worker + tests):
QUEUED → BUILDING → fetch source (WORK_DIR/<id>/src) → detect → repo Dockerfile | generated template | compose services | image →
`docker build` (BuildKit, `--progress=plain`, every line → `appendLog(id,"BUILD")` batched) → DEPLOYING + `queues.deploy.add` —
or ERROR `{ errorStep: SOURCE|DETECT|BUILD, errorMessage: last meaningful lines }`. Logs always ended + archived, work dir removed.
- Cancel: `ld:cancel` pub/sub + 3 s polling of `isCancelRequested` → kills the docker build process group (BuildKit cancels the solve).
- Timeout: `build.timeoutMinutes`. Concurrency: in-process gate on `build.concurrency` (BullMQ concurrency = `WORKER_CONCURRENCY_BUILD` || 4).
- Cache: BuildKit cache mounts (npm/pnpm/yarn/bun/pip/uv/go/cargo/maven/gradle/nuget/composer/hex), Next.js `.next/cache` per project,
  `--cache-from` the project's previous image + `BUILDKIT_INLINE_CACHE=1`.
- Env: project vars for the target (+ branch overrides, shared groups) → non-secret as `--build-arg` (declared `ARG` in the build stage
  only), `isSecret` as BuildKit secrets (`--secret id=KEY,env=…`, mounted `env=KEY` in install/build RUN steps, never in a layer).
- Build proxy (`build.proxy`): `HTTP(S)_PROXY/NO_PROXY` build args (predefined ARGs, not in history), CA as the `levant_ca` secret mounted in
  install/build steps of generated Dockerfiles (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, PIP_CERT, REQUESTS_CA_BUNDLE, GIT_SSL_CAINFO,
  CARGO_HTTP_CAINFO, DENO_CERT, BUNDLE_SSL_CA_CERT, HEX_CACERTS_PATH, COMPOSER_CAFILE; JVM: temp truststore + proxy system props),
  `network: host` → `docker build --network host`. User Dockerfiles get the proxy args (+ the secret, unused unless they mount it).
- Worker restart: a build job that finds its deployment already BUILDING marks it ERROR ("interrupted"); `onWorkerStart` fails orphaned
  BUILDING rows with no live job and GCs work dirs older than 6 h.

## Known gaps
- Native extensions needing system packages at build time (e.g. Python sdists without wheels, `pg`/`mysql2` gems' libs in the slim runtime)
  — no apt step in templates (use a repo Dockerfile). Ruby builds in the full `ruby:<v>` image for that reason.
- Monorepos: workspace install from the root lockfile is supported for Node only.
- `build.registryMirror` applies to generated Dockerfiles only (repo Dockerfiles / compose images use Docker Hub directly).
- SvelteKit with adapter-auto is switched to adapter-node at build time; Remix/React Router run their `start` script.
