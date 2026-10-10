# builder-ui — notes & requests

Owner: builder-ui (wave E). DB `levantdeploy_bui`, Redis db 15, port 3115, `NEXT_DIST_DIR=.next-bui` (`control/.env.bui`, gitignored).

## What builder-ui owns
- Pages: `/{team}/build` (`src/app/(dashboard)/[team]/(team)/build/page.tsx`) and the full-screen editor
  `/{team}/build/{id}` (`src/app/(dashboard)/[team]/build/[id]/page.tsx`, outside the `(team)` layout).
- Components: `src/components/builder/**` (prompt box, projects grid + live thumbnails, templates/remix gallery, editor:
  chat, preview, visual-edit inspector, add-section library, code, history, backend, publish, settings, share).
- Client libs: `src/lib/builder-ui/**` — typed client `api.ts` (all API paths live there), run-event reducer
  `run-state.ts`, bridge protocol types `bridge.ts`, Tailwind class swapping `tailwind.ts`, diff helpers `diff.ts`,
  section catalog `sections.ts`, mock mode `mock.ts` (+ a reference bridge in `mock-preview.ts`) — tests in `builder-ui.test.ts`.
- Landing hook: `<BuilderPromptHero signUpHref="/register" />` from `@/components/builder/builder-prompt-hero` — for the
  landing owner. It stores the prompt in `localStorage["ld-builder-pending"]` and sends the visitor to sign-up; after
  registration the team Overview (where sign-up lands) / Build page pick it up and start building automatically.

## Mock mode
Only for early UI work: `?mock=1` once (stored in `localStorage["ld-builder-mock"]`, `?mock=0` clears). Never on by default.

## Contracts consumed
### builder-agents (implemented, used as is)
- `POST /api/v1/builder/projects/:id/runs { message, mode: build|chat|fix, attachments?: [{url (https or data:image…), name, type}] }`
  → `{ run, messageId, credits }`. Chat images are sent as (downscaled) data URIs. Element context from
  "Ask AI about this element" is appended to the message text (`[Selected element: … — source path:line:col — text "…"]`).
- `GET …/runs`, `GET …/runs/:runId`, `POST …/runs/:runId/cancel`, `GET …/runs/:runId/events?after=` (SSE). The UI reads
  the stream with fetch (not EventSource) and reconnects from the last seq only while the run is active.
- Event types rendered: status, phase (→ plan-card steps ticking), plan (summary), thinking, tool, file (diff → mini
  diffs), commit (groups the preceding `file` events), check, provider (`fallback.from` → "provider: X, fell back from Y"
  chip), warning/error/backend/sql/restore (notices), message (final text), usage. Unknown types are ignored.
- `GET /api/v1/builder/credits?team=` → `{ credits: BuilderCredits }` (credit counter in the composer / prompt box).
- **Request (builder-agents):** `GET /api/v1/builder/projects/:id/messages` → `{ items: BuilderMessage[] }` (oldest first)
  for the chat history (unless builder-core provides it). Optional: a `context` field on POST runs instead of the
  bracketed element text, and `suggestions` (`{ items: string[] }`) event after a run for follow-up chips.

### builder-core (expected — the client adapts to builder-core.md once documented)
- projects: `GET /api/v1/builder/projects?team=` → `{ items }`; `POST { team, name, prompt, template, visibility }` →
  `{ project, run? }` (if no run comes back the UI starts one with `mode: build`); `GET|PATCH|DELETE /projects/:id`
  (`DELETE ?confirm=<name>`; PATCH `name`, `description`, `settings` partial: knowledge, instructions, theme{colors,font,radius,mode}, quality fast|balanced|best, visibility).
  DTO fields used: id, name, prompt, status, previewStatus, previewUrl, previewError, baseRef, project{slug}, settings,
  lastCommit, lastPublishedAt, thumbnailUrl?, updatedAt.
- `GET /api/v1/builder/templates` → `{ items: [{ id, name, description, prompt?, thumbnail?, kind: template|remix, projectId? }] }`
- files: `GET …/:id/files[?ref]` → `{ items: [{ path, size }] }`; `GET …/:id/files/content?path=&ref=` → `{ path, content, binary? }`;
  `PUT …/:id/files/content { path, content, message }` → `{ commit }`; `GET …/:id/files/search?q=` → `{ items: [{ path, line, text }] }`
- history: `GET …/:id/commits` → `{ items: [{ sha, message, date, author: { kind: agent|user|visual|system, role?, name? }, published? }] }`;
  `GET …/:id/commits/:sha` → `{ commit, files: [{ path, status, additions, deletions, patch }] }`; `POST …/:id/restore { sha }` → `{ commit }`
- preview: `GET …/:id/preview` → `{ status, url, error?, errors?: [{ message, route?, at? }] }`; `POST …/:id/preview { action: start|restart }`
- visual edit: `POST …/:id/visual-edit { ops, message? }` → `{ commit }` (op shapes = `VisualEditOp` in `src/lib/builder-ui/types.ts`, same as lib/builder/visual-edit.ts)
- uploads (image replace): `POST …/:id/uploads` multipart `file` → `{ url }` (backend storage when attached, else platform storage)
- publish: `GET|POST …/:id/publish` → `{ deployment: { id, status }, url, lastPublishedAt, lastPublishedCommit, project: { slug } }`;
  progress uses the existing `/api/v1/deployments/:id`, team status SSE and `<LogViewer deploymentId stream="BUILD">`.
- export: `GET …/:id/export.zip`, `POST …/:id/export/github { repo, private }` → `{ url, repo }`; share: `POST …/:id/share { enabled }` → `{ url, expiresAt }`
- backend: `POST …/:id/backend { create: true } | { ref }` → `{ project }`. The Backend panel reads tables / auth users /
  buckets through the existing `POST /api/v1/base/projects/:ref/sql` (read-only queries) and opens Studio via `POST …/studio`.
- bridge: builder-core's `components/levant/bridge.tsx` implements the protocol in `src/lib/builder-ui/bridge.ts` (thanks!).
  The editor sends `mode { enabled }` after every `ready` (so the framed preview is interactive unless Visual edit is on).
- Section library ids = `builder-template/library/index.json` (navbar, hero, features, stats, pricing, testimonials, team,
  gallery, blog-list, faq, cta, contact-form, auth-forms, footer). Insert = `{ op: "insert", target: sectionSrc, position: before|after, component }`.

## Findings for builder-core (from real runs on the builder-ui stack)
- (fixed by builder-core meanwhile) HMR websocket 502 through the forward-auth hop. The editor still reloads the preview once
  after a run ends (new routes/pages).
- Suggestion: `devIndicators: false` in the template's next.config — the Next dev "N" badge shows inside the editor preview.
- Verified cross-site (dashboard http://localhost:3115, previews https://preview-*.levant.localhost via own Caddy
  `bui-caddy` :8445 with `PROXY_TLS=internal`, `PLATFORM_SCHEME=https`): the Partitioned SSO cookie works inside the iframe,
  bridge select/edit/commit work.
- The UI uses `GET …/preview` `url` only once per load (it is a one-time SSO URL) and requests a fresh one via
  `GET …/preview/url?next=` for reloads, route changes before the bridge is ready, thumbnails and "open in new tab".

## Endpoint added by builder-ui
- `GET /api/v1/builder/projects/:id/messages?limit=&before=` → `{ items, next }` (read-only chat history; nobody else provided it).

## Shared-file changes by builder-ui (all additive)
- `src/components/shell/nav.ts`: team tab "Build" (`/{team}/build`) after Overview.
- `src/lib/teams.ts`: `"build"` added to `RESERVED_PROJECT_SLUGS`.
- `src/app/(dashboard)/[team]/(team)/page.tsx` (dashboard): `<BuilderOverviewPrompt/>` card on top of the Overview (MEMBER+).
- `src/app/(dashboard)/[team]/layout.tsx`: command palette action "Build an app with AI…".
- `src/components/ai/assistant-launcher.tsx`: the floating "Ask AI" button is hidden inside the builder editor (⌘J still works).
- CSP: the policy moved verbatim from `next.config.mjs` into `control/security-headers.mjs` (`contentSecurityPolicy()`, + `.d.mts`),
  imported by `next.config.mjs` (unchanged policy for all routes). `src/middleware.ts` re-sets the header for `/{team}/build[/{id}]`
  only, adding `frame-src 'self' https://*.{PLATFORM_DOMAIN}(:*)` (+ http in dev / PLATFORM_SCHEME=http) computed at RUNTIME
  (the Docker image is built without the domain). CSP host wildcards must be the left-most label, so `preview-*.` is not usable.
- `src/lib/plans/limits.ts` (+ test) and `src/app/(dashboard)/settings/plans/plans-client.tsx`: "AI app builder" group in the admin
  plan editor (messages/day, messages/month, daily bonus, builder apps, preview hours/month) and in the limits JSON schema.
- `package.json`: `@codemirror/lang-css@6.3.1`, `@codemirror/lang-json@6.0.2`, `@codemirror/lang-sql@6.10.0` (pinned).
