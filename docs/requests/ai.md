# AI area — notes & requests

Owner: `src/lib/ai/**`, `src/components/ai/**`, `src/app/api/v1/ai/**`, `src/app/(dashboard)/[team]/[project]/ai/**`, `src/worker/processors/ai.ts`, `scripts/fake-anthropic.ts`, `scripts/ai-e2e.ts`.

## Changes outside my area (all additive)
| file | change | owner to review |
|---|---|---|
| `package.json` | `@anthropic-ai/sdk@0.131.0` (exact pin) | lead |
| `src/lib/settings.ts` | new keys `ai.effort`, `ai.apiKeyEnc` (encrypted key), `ai.autoDiagnose` (next to existing `ai.enabled`, `ai.model`) | foundation |
| `src/app/(dashboard)/[team]/layout.tsx` | **one mount line** `<AssistantLauncher />` (+ import) inside `CommandPaletteProvider` → floating "Ask AI" button + panel on every team/project page (⌘J) | dashboard |
| `src/app/(dashboard)/[team]/[project]/deployments/[deploymentId]/page.tsx` | one JSX line (+2 imports): `{d.status === "ERROR" && <AiDiagnosisBanner … />}` above the status timeline → "Ask AI to fix" + stored diagnosis | dashboard — please keep it if you rework the page |

No schema change. `AgentAction.status` uses the existing enum: `PENDING_APPROVAL` = *proposed*, `APPROVED`, `REJECTED`, `RUNNING`, `SUCCEEDED` = *executed*, `FAILED`.

## Requests to other areas
- **build**: please honour `project.buildSettings.dockerfileInline` (a full Dockerfile text, written by the agent's `generate_dockerfile save=true` after user approval): when set, write it to the build context as `Dockerfile.levant` and build with it. Then export `SUPPORTS_DOCKERFILE_INLINE = true` from `src/lib/build/index.ts` (or `dockerfile.ts`/`detect.ts`) — the agent then stops telling users it may not be applied. The agent already uses `detect(dir, settings)` + `generateDockerfile({ detection, settings })` when a source snapshot exists.
- **build**: keeping `STORAGE_DIR/work/{deploymentId}/src` (or the upload tarball) for the latest deployment per project lets `read_repo_file` work for git projects; today it works for uploads and for work dirs that still exist.
- **runtime**: adapters call `src/lib/runtime/deploy.ts` → `restartDeployment(deploymentId)` and `rollbackTo(deploymentId, userId)`. For `create_database` please export `createDatabase({ teamId, projectId, engine, name, version?, userId })` from `src/lib/runtime/databases.ts` (or `index.ts`); until then the tool answers "not available yet".
- **runtime/domains**: if you add `src/lib/domains/index.ts` exporting `addDomain({ projectId, hostname, redirectTo, gitBranch, userId })` and `checkDomainDns(domainId)`, the agent uses them; fallbacks today: PENDING `Domain` row + `queues.domains.add`, and live `node:dns` lookups.
- **ops**: a future platform settings page can mount `<AiSettingsCard />` from `@/components/ai/ai-settings` (today: gear icon in the panel / "Settings" on the AI tab, platform owner only).
- **dashboard**: `<AskAiButton deployment={{ number, errorStep, errorMessage }} />` from `@/components/ai/ask-ai` can be placed anywhere (it opens the panel pre-filled and sends).

## API
```
GET  /api/v1/ai/status                         → { enabled, configured, model, effort, autoDiagnose, canConfigure }
GET|PUT /api/v1/ai/settings                    (platform owner) { enabled?, model?, effort?, autoDiagnose?, apiKey?: string|null } — key stored encrypted, only ••••last4 returned
GET  /api/v1/ai/conversations?team&project&scope   POST { team, project? }      (private to the user)
GET|PATCH|DELETE /api/v1/ai/conversations/:id      → { conversation, messages, actions, state }
POST /api/v1/ai/conversations/:id/messages { content, page? }   → text/event-stream of AgentEvent
POST /api/v1/ai/actions/:id/approve { confirmText? }            → SSE (executes, then the agent continues)
POST /api/v1/ai/actions/:id/reject  { reason? }                 → SSE
GET|POST /api/v1/ai/deployments/:id/diagnose                    → stored / fresh one-shot diagnosis (deployment.meta.aiDiagnosis)
```
Audit actions: `ai.action.execute`, `ai.action.reject`, `ai.env.reveal`, `settings.ai.update`, plus the normal `env.create|update|delete`, `project.update`, `deployment.create|rollback|restart`, `domain.add`, `database.create` written by the tools (meta `via: "ai"`).

## Testing without a key
```
npx tsx scripts/fake-anthropic.ts 4105                        # fake Messages API (SSE, scripted tool_use flows, request validation)
# .env.ai (gitignored): DATABASE_URL=…levantdeploy_ai, REDIS_URL=…/5, PORT=3105, NEXT_DIST_DIR=.next-ai,
#                       ANTHROPIC_BASE_URL=http://127.0.0.1:4105, ANTHROPIC_API_KEY=sk-ant-fake-…
set -a; . ./.env.ai; set +a; npx next dev -p 3105
set -a; . ./.env.ai; set +a; npx tsx scripts/ai-e2e.ts        # 50+ checks, exits non-zero on failure
npx vitest run src/lib/ai                                       # unit tests (validation, permissions, request shape, tar reader…)
```
`ANTHROPIC_BASE_URL` is for tests only.

## Gaps
- `rollback` / `create_database` depend on runtime exports (see above); `restart` falls back to `docker restart` by `levant.deployment` label.
- `read_repo_file` needs a kept snapshot (work dir or upload tarball).
- Auto-diagnosis runs in the worker (subscribes to `ld:deployments:status`, dedup key `ld:ai:diag:<id>`), only when Settings → AI → "Diagnose failed deployments" is on.
