# base-dashboard — notes, contracts & results

Status: DONE (wave C). Isolation: DB `levantdeploy_bdash`, Redis db 8, port 3108, `control/.env.bdash` (gitignored,
`NEXT_DIST_DIR=.next-bdash`, storage `control/storage/bdash`), own Caddy container `bdash-caddy` on 127.0.0.1:9080/9443
(admin 127.0.0.1:2029, removed after the runs) so the shared `levant-caddy` routes of other agents were never overwritten.

## What lives where
| Path | What |
|---|---|
| `src/lib/base-ui/shared.ts` | client-safe types, status styles, services, OAuth providers, templates, quick-start snippets, `isReadOnlySql`, password rules, `connectEnvVars` |
| `src/lib/base-ui/adapters.ts` | the ONE place UI/API/AI call `@/lib/base` (runtime) and `@/lib/plans` — shape adapters + `BaseError` → HTTP (`publicError()`) |
| `src/lib/base-ui/{access,dto,settings,events,usage,connect}.ts` | role checks (`requireBaseRole`, page contexts), DTOs, settings view, SSE lifecycle stream, usage vs plan, Deploy env connect |
| `src/app/api/v1/base/**` | public API (below) |
| `src/components/base/**` | Base UI (page views in `components/base/pages/*`, rendered by two route trees) |
| `src/app/(dashboard)/[team]/(team)/base/{page,new}` | team "Base" tab: overview of every backend + create (standalone) |
| `src/app/(dashboard)/[team]/base/[ref]/**` | standalone backend pages (redirect to the owning project's Backend tab when attached) |
| `src/app/(dashboard)/[team]/[project]/backend/**` | Deploy project "Backend" tab: "Add a backend" (create / attach existing) or the Base pages |
| `src/lib/ai/tools/base.ts` | AI tools `list_base_projects`, `get_base_project`, `run_base_sql`, `base_logs` |
| `src/lib/base-ui/base-ui.test.ts` | unit tests (SQL read-only gate, passwords, env vars, masking, snippets) |
| `scripts/seed-base-demo.ts` | demo rows for UI work/screenshots (`--clean` removes them) + viewer@/member@ users |

Pages: Home (live status/activity via SSE, API URL, anon key copy, service_role reveal ADMIN+ audited, quick start
supabase-js/Next.js/Flutter/curl, service health grid, live provisioning screen), Open Studio (SSO hand-off, waits while
Studio boots), Database (transaction/session pooler, inside-project string, internal API URL, public port toggle with TLS
note, backups create / download SQL + files / restore with typed confirmation), Auth (URLs, sign-in methods, JWT expiry,
19 OAuth providers with encrypted secrets, SMTP + test mail, email templates), Edge Functions (list, create from 4
templates, CodeMirror editor `@uiw/react-codemirror@4.25.12` + `@codemirror/lang-javascript@6.2.5`, deploy/⌘S, verify-JWT,
secrets, invoke tester anon/service/none, logs), Logs (per-service live tail in the LogViewer), Usage (bars vs plan +
30-day charts), Settings (name, pause/restore, restart all/one service, versions/upgrade, custom API domain with DNS check,
attach/detach Deploy project, transfer, delete).

## API (`/api/v1/base/**`, session or API token — scopes `base:read` / `base:write`)
```
GET|POST /projects?team=                          list / create {team,name,dbPassword?,projectId?,connectEnv?,includeServiceRole?}
GET|PATCH|DELETE /projects/:ref (?confirm=name)    PATCH {name} ADMIN, DELETE ADMIN
GET  /projects/:ref/keys[?reveal=service_role]    anon VIEWER; service_role ADMIN (audited)
GET  /projects/:ref/connection[?reveal=1]         MEMBER masked; reveal ADMIN (audited)
POST /projects/:ref/connection/public-port {enabled}   ADMIN, plan-gated by the runtime (402)
POST /projects/:ref/actions {action: pause|resume|restart|upgrade, service?}   ADMIN (single-service restart MEMBER; resume re-checks the plan cap)
GET  /projects/:ref/events                        SSE (status + BaseEvent rows) or ?format=json
GET  /projects/:ref/health                        service states
GET|POST /projects/:ref/studio                    state / one-time SSO URL (MEMBER; session or token with base:write)
GET|POST /projects/:ref/backups; GET …/:id/download[?part=storage]; POST …/:id/restore {confirm}
GET|PATCH /projects/:ref/auth; POST /projects/:ref/auth/smtp-test {to}
GET|POST /projects/:ref/functions; GET|PATCH|DELETE …/:slug (files? kept from compat); POST …/:slug/invoke {auth: anon|service_role (ADMIN, audited)|none}; GET …/:slug/logs
GET|PUT /projects/:ref/secrets {set, remove}       names only; PUT ADMIN
GET  /projects/:ref/logs?service=                  SSE
GET  /projects/:ref/usage
POST /projects/:ref/sql {sql (≤ 5 MB), maxRows}   MEMBER; read-only → read-only tx; anything else audited
GET|PUT|DELETE /projects/:ref/domain; POST …/domain/verify   custom API domain (domains lib validation + DNS check)
POST /projects/:ref/transfer {team, confirm}      ADMIN in both teams
POST|DELETE /projects/:ref/connect                 connect env vars to a Deploy project (+ attach); DELETE detaches
```
Every mutation is audited (`base.*`). VIEWER sees; MEMBER Studio/functions/SQL/connect; ADMIN+ secrets, settings,
backups, public port, domain, pause/delete/transfer.

## Deploy integration (one product)
- Project tab **Backend** (between Environment and Storage); project overview **Backend card**; team tab **Base** (overview,
  rows link to the owning project's Backend tab; standalone backends live at `/{team}/base/{ref}`).
- Attach/create writes `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL` (internal
  `http://base-{ref}:8000` for Production/Preview, public for Development), `SUPABASE_ANON_KEY`, optional
  `SUPABASE_SERVICE_ROLE_KEY` (secret, ADMIN) and `DATABASE_URL` (secret, pooler transaction `base-{ref}:6543` or session)
  via the env-vars lib → the existing "redeploy to apply" banner shows.
- Environment page: **Connect a Base project** card (backend, targets, service key, DATABASE_URL).
- Deleting a project asks **keep** (backend becomes standalone, FK SetNull) or **delete** it (`?backend=delete`).
- Transferring a project moves its backend to the new team.
- Command palette: Base projects, Base pages, "Create Base project…", "Base".

## Shared-file changes (additive)
- `src/components/shell/nav.ts`: team tab "Base"; project tab "Backend".
- `src/lib/teams.ts`: `base`, `backend` in `RESERVED_PROJECT_SLUGS`.
- `src/lib/auth/tokens.ts`: scopes `base:read`, `base:write`.
- `src/app/(dashboard)/[team]/layout.tsx` (palette), `[project]/page.tsx` (Backend card), `[project]/environment/page.tsx`
  (Connect card), `[project]/settings/advanced/page.tsx` + `components/dashboard/project-settings.tsx` (keep/delete backend),
  `api/v1/projects/[id]/route.ts` (DELETE `?backend=`), `api/v1/projects/[id]/transfer/route.ts` (backend moves).
- `src/lib/ai/tools/index.ts` (+4 tools), `src/lib/ai/prompt.ts` (one bullet), `src/lib/ai/ai.test.ts` (count 25 + run_base_sql policy test).
- `src/lib/base/stack.ts` (base-runtime file): `provision()` writes throttled progress BaseEvents for the live screen.
- `package.json`: `@uiw/react-codemirror@4.25.12`, `@codemirror/lang-javascript@6.2.5` (exact).

## Verified
- `npx tsc --noEmit` clean, `npm test` 242/242, `next build` OK.
- Real stacks driven through the UI with Playwright (one of mine at a time, deleted afterwards):
  - pass 1 (14/14): create from demo-app's Backend tab → ACTIVE in ~28 s → keys + env vars written → service_role
    reveal → `/auth/v1/health` 200 through Caddy → **Open Studio** (SSO → `/project/default`) → function from template,
    edit in the editor, redeploy, invoke 200 → auth settings saved and applied → pause → PAUSED → restore → ACTIVE →
    service logs SSE → delete (containers, volumes, project dir gone).
  - pass 2 (12/12): standalone create with live progress events → connect env incl. service key + DATABASE_URL (pooler
    `base-{ref}:6543`) → public port toggle → `psql … sslmode=require` → 42 → backup → download SQL + files → restore with
    typed confirmation → audit entries for every action.
  - AI tools on the live project: list/get (no secrets), SELECT runs read-only, CREATE needs approval, viewer refused.
- Screenshots: `docs/screenshots/base/` — 22 views × dark/light × desktop/390 px (demo rows) + `e2e-*` from the real runs.

## Known limitations
- Demo-seeded rows have no containers: health shows "Not running", logs are empty — expected.
- The compat fixes (invoke auth choice, Studio via token, 5 MB SQL) were applied after the real runs; covered by tsc/tests,
  not re-run against a live stack.
