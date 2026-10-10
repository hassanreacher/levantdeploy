# builder-agents — AI agents for the app Builder (contracts, notes, results)

Isolation: DB `levantdeploy_bagents`, Redis db 14, port 3114, `control/.env.bagents` (gitignored), storage `control/storage-bagents/`.

## What lives where
| Path | What |
|---|---|
| `control/src/lib/builder/agents/types.ts` | provider-agnostic conversation, plan schema, events, run state/checkpoint, budgets |
| `…/agents/orchestrator.ts` | `executeRun(deps, runId, { signal?, budgets?, codeConcurrency? })` — persisted, resumable state machine |
| `…/agents/agent.ts` | `RunContext` (budgets, cancel, resilient LLM step, events, checkpoints, serialized commits) + `runAgent` tool loop |
| `…/agents/tools.ts` | tools (zod → OpenAI schema), path safety, content guard (service_role / hardcoded keys), role tool sets, write allow-lists |
| `…/agents/patch.ts` | search/replace edits with tolerant matching (exact → whitespace → indentation → fuzzy) + line diffs |
| `…/agents/repair.ts` | tolerant JSON; tool calls written as text (Hermes tags, fenced JSON, `name({...})`) |
| `…/agents/prompts/*.md`, `prompts/docs/*.md` | role system prompts + shared stack conventions; `read_docs` cheat sheets (next15, shadcn, supabase-js, supabase-auth, rls, storage, tailwind, accessibility, seo) |
| `…/agents/adapters.ts` | ports (Workspace, Checks, Backend, RunStore, EventBus) + git-CLI / in-memory implementations (tests) |
| `…/agents/deps.ts` | production wiring: `@/lib/llm`, builder-core (`git`, `workspace`, `preview.runCheck/getPreviewErrorMessages/addDependency`, `backend.attachBackend`), LevantBase (`runSql`, `generateTypes`, `deployFunction`) |
| `…/agents/llm-adapter.ts` | LlmPort over `llm.chat / ensemble / judge / candidates`; keeps `toolCalls[].extra` (Gemini thought signatures) |
| `…/agents/store.ts` | Prisma store (BuilderRun / BuilderRunEvent / BuilderMessage) + Redis bus (`ld:builder:run:<runId>`, cancel channel `ld:builder:cancel`) |
| `…/agents/runs.ts` | `startRun`, `getRunDTO`, `listRuns`, `cancelRun`, `runEventStream` (SSE) |
| `…/agents/http-access.ts` | route access (wraps builder-core `requireBuilder`; Next-only) |
| `…/agents/testing.ts`, `agents.test.ts`, `credits.test.ts` | scripted fake LLM + unit/orchestrator/credit tests |
| `control/src/worker/processors/builder.ts` | queue `builder`: run / resume / cancel (abort in-flight LLM call) / sweep |
| `control/src/app/api/v1/builder/projects/[id]/runs/**`, `…/builder/credits` | run + credits API |
| `control/scripts/builder-agents-e2e.ts` | live end-to-end driver (in-process run with the production ports) |

## HTTP API (consumed by builder-ui)
```
POST /api/v1/builder/projects/:id/runs                MEMBER  { message, mode?: "build"|"chat"|"fix" (default build),
                                                              attachments?: [{ url: https | data:image/*;base64, name?, type? }] (≤ 4, ≤ 5 MB) }
     → 201 { run: RunDTO, messageId, credits }   402 PLAN_LIMIT (credits) · 409 CONFLICT { runId } (a run is active) · 429
GET  /api/v1/builder/projects/:id/runs                VIEWER  → { items: RunDTO[] } (newest first, 20)
GET  /api/v1/builder/projects/:id/runs/:runId         VIEWER  → { run }  (?events=1&after=<seq> → { run, events })
POST /api/v1/builder/projects/:id/runs/:runId/cancel  MEMBER  → { run }  QUEUED → CANCELED at once; RUNNING → in-flight LLM call aborted, partial changes committed, CANCELED
GET  /api/v1/builder/projects/:id/runs/:runId/events  VIEWER  SSE — replays stored events after ?after= / Last-Event-ID, then live; closes after the final status
     message: `id: <seq>` · `event: <type>` · `data: {"seq","type","data","at"}`; `: ping` every 15 s
GET  /api/v1/builder/credits?team=<id|slug>           VIEWER  → { credits: BuilderCredits }
```
- `RunDTO = { id, builderProjectId, mode, status (QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELED), phase, prompt, plan, steps, usage, error,
  baseCommit, resultCommit, cancelRequested, createdAt, startedAt, finishedAt, lastSeq }`
- `steps = [{ key, role, title, status: running|done|failed|skipped, startedAt, finishedAt, commitSha?, detail? }]`
  (keys: `plan`, `backend`, `design`, `code:<group>`, `check:<i>`, `fix:<i>`, `summarize`, `answer`)
- `usage = { byProvider: { gemini: { calls, inTokens, outTokens, failures } }, total: { calls, inTokens, outTokens, steps, tokens } }`
- `BuilderCredits = { plan, usedToday, usedMonth, bonusUsedMonth, limits: { messagesPerDay, messagesPerMonth, dailyBonus, projects, previewHoursMonth },
  remainingToday, remainingMonth, allowed, reason: "daily"|"monthly"|null, resetsAt: { day, month } }` (null = unlimited)
- `startRun` creates the USER `BuilderMessage` (`agentRunId` = run) and the run; when the run ends an ASSISTANT `BuilderMessage`
  (`agentRunId`, `commitSha`, `meta.mode`) holds the reply (also for failed/canceled runs). `BuilderProject.status` = GENERATING during a
  build/fix run, READY after.

### Events (`type` → `data`)
| type | data |
|---|---|
| status | `{ status, mode?, resumed?, error?, commit? }` — the final one closes the stream |
| phase | `{ phase: plan|backend|design|code|check|summarize|answer, label }` |
| plan | `{ plan: { summary, kind, pages, components, dataModel, backend, design, files: [{path, action, purpose, group}], dependencies } }` |
| thinking | `{ role, text }` — model prose between tool calls, judge reasoning |
| file | `{ role, path, action: create|modify|delete|rename, diff?, added?, removed?, from?, via? }` (diff = unified-ish line diff) |
| tool | `{ role, name, args, ok, result }` — non-file tools and failed tool calls |
| check | `{ kind: typecheck|lint|build|preview, ok, skipped?, iteration, output }` |
| provider | `{ role, provider, model, fallbacks: [{from, to, reason}], attempt?, retriedAfter?, candidate? }` |
| warning | `{ message, role?, provider? }` — provider failed → retried elsewhere, rate-limit wait, repaired tool calls, resumed run, budget |
| error | `{ message, phase?, role? }` — a phase/agent failed; the run continues when possible |
| commit | `{ sha, message, author }` — authors `agent:<role>` (builder-core history classifies them as agent commits) |
| restore | `{ sha, to, reason }` — checks never went green → restored to the last green commit |
| backend | `{ ref, url?, action: attached|bucket|function, … }` · `sql` `{ description, ok, error, migration, sql }` |
| message | `{ content, commit? }` final assistant reply · `usage` `{ tokens, steps, providers }` |

## Orchestrator
- **build**: plan → backend (if needed) → design (first build / restyle) → code → check & fix → summarize. **fix**: check & fix seeded with
  the user's report → summarize. **chat**: one read-only agent (list/read files, docs, preview errors), no commits.
- **Plan**: best-of-N (`llm.ensemble` on 2 providers — or 2 models when only one provider is up) + `llm.judge`; fallback single call
  (retries), then a heuristic plan. Normalized (no `components/ui/*`, `.env*`; backend forced on when auth/data model).
- **Backend**: `attachBackend` (builder-core: creates/reuses the LevantBase project, writes the preview `.env.local`) + wait ACTIVE, then the
  Backend agent: `base_sql` with `migration_name` → applied with `runSql`, then saved to `supabase/migrations/<UTC ts>_<name>.sql`;
  RLS + per-operation policies; `base_create_bucket`; auth pages; `base_types` → `lib/database.types.ts` (regenerated automatically
  after migrations). SQL deny-list (roles, ALTER SYSTEM, COPY PROGRAM, dropping platform schemas, altering auth/storage tables).
- **Design**: Designer may only write `app/globals.css`, `tailwind.config.ts`, `app/layout.tsx`, `components/site-*.tsx`, `public/**`.
- **Code**: file groups from the plan → Coder agents (2 in parallel when ≥ 2 providers are available, else 1), each group committed
  with only its own paths; failed groups retried once with a fresh conversation.
- **Check & fix** (N = 5): typecheck → lint → build (build only when the first two pass) + preview runtime errors. Fixer agent with the
  condensed errors (smallest patches). From iteration 3, or when the error signature repeats: best-of-N JSON search/replace candidates on
  2 providers/models, dry-run applied in memory, judge picks, applied. Still red → the attempt is committed ("WIP …"), the tree is restored
  to the last green commit (new commit), the run ends FAILED with the errors. Green → `lastGreenCommit`.
- **Summarize**: short user-facing reply (fallback: deterministic text) → ASSISTANT message.
- Tools: list_files, read_file, write_file, apply_patch, delete_file, rename_file, add_dependency, run_check, get_preview_errors, base_sql,
  base_create_bucket, base_types, deploy_function, read_docs, finish. Path safety (relative, no `..`, no symlink escape, no
  `.git/node_modules/.next`, no `.env*`/lock writes); content guard rejects `NEXT_PUBLIC_*SERVICE*`, service_role in `"use client"`
  files, hardcoded JWT/API keys, invalid JSON. Weak-model aids: tool calls written as text are repaired, writer roles that answer
  without touching files are nudged (×2), old tool output is compacted when the conversation grows.

### Resilience ("if one fails the next continues")
- every call → `llm.chat` (the router falls back between providers/models inside the call);
- if a call still fails, the orchestrator retries the SAME step with that provider excluded (5 tries); when every candidate is
  rate-limited/cooling down it waits (5 s → 60 s backoff, ≤ 4 min per step) — same conversation, any provider;
- a failing phase/agent degrades the run (error event) and the next one continues; only cancel, budget (160 LLM steps / 3 M tokens per
  run, 24 turns per agent) or "no provider at all" stop early (budget → summary still written);
- state is checkpointed after every agent turn (`BuilderRun.state`); a worker restart resumes: completed phases are skipped, the
  in-flight agent continues its conversation (BullMQ stalled job + `builder-resume` start hook + 2-min sweep re-enqueue RUNNING runs).

## Shared-file changes (additive)
- `prisma/schema.prisma`: `BuilderRun.phase String?`, `BuilderRun.state Json?`.
- `src/lib/queues.ts`: queue `builder` (`{ runId?, sweep? }`, attempts 1).
- plans (`src/lib/plans`): `builder` limits group in `PlanLimits` (`messagesPerDay, messagesPerMonth, dailyBonus, projects,
  previewHoursMonth`; Hobby 5/day & 30/month & 5 apps · Pro 100/month + 5/day bonus · Team 500/month · Unlimited none) with a schema
  default; `defaultLimitsForSlug()` so stored plans without `builder` get their slug's defaults (planFor uses it);
  `assertCanUseBuilder(teamId, {userId})` → 402 PLAN_LIMIT `builder.messagesPerDay|builder.messagesPerMonth`;
  `assertCanCreateBuilderProject(teamId)`; `builderCredits(teamId)`; counters `builderMessageTimes` (one BuilderRun per user message =
  one credit) and `builderProjects`; enforce flags `builder.messages` / `builder.projects`; `setPlanDeps` accepts partial counters.
  Not yet in the admin plans form / RESOURCES (plans area may add fields).

## Requests
- **builder-core**: call `assertCanCreateBuilderProject(teamId, { userId })` when creating a builder project. One-off check containers
  (preview not running) go through the runtime entrypoint, which reinstalls whenever `/app/package.json` differs from the base
  one — `createWorkspace` renames the package, so every one-off `runCheck` spent ~5 min in a failing install in my tests (I kept a
  `BUILDER_AGENT_CHECKS=docker` fallback that links the modules directly). Comparing only the dependency sections would avoid it.
  `runCheck("lint")` lints `.levant/build-check/**` (the build check's distDir) → dozens of errors in generated `.d.ts` files and a
  truncated JSON (no diagnostics). Please add `.levant/**` to the template's `eslint.config.mjs` ignores (and/or pass
  `--ignore-pattern`). The agents run lint through `execInPreview` with explicit ignore patterns meanwhile.
- **builder-ui**: everything above; `steps`, `plan`, `file.diff`, `provider` and `warning` events are meant for the progress UI.

## Tests
- `src/lib/builder/agents/agents.test.ts` (33 with credits): patch strategies, text tool-call repair, path safety incl. symlink escape,
  content guard, zod→schema, prompts/docs, plan normalization, compaction; orchestrator with a scripted fake LLM: plan → design → code →
  check → fix → summarize (role-authored commits, diffs, steps), provider failure mid-run → next provider continues the same
  conversation, failing coder group → retried while others continue, global rate-limit cooldown → waits then continues, cancel (partial
  commit), resume after a worker crash from the checkpoint, lease (no double execution), restore to last green when checks never pass,
  best-of-N plan + judge + ensemble fix, backend agent (migration saved only after it applied, SQL deny-list, types), chat mode +
  repaired tool calls, fix mode, no provider at all, step budget.
- `credits.test.ts`: Hobby 5/day & 30/month, Pro 100 + 5/day bonus, Team 500, unlimited, enforce flag, builder projects, slug defaults.
- `store.int.test.ts` (real Postgres + Redis, `BUILDER_AGENTS_DB_TEST=1`): startRun → run → messages/steps/usage, SSE replay +
  Last-Event-ID, 409 on concurrent run, cancel of a queued run.
- Whole project: `npx tsc --noEmit` clean, `npm test` 381 passed / 1 skipped (the DB integration test).

## Results — live runs (Gemini only; sandbox, 2026-10-10)
Only Gemini is reachable from the sandbox; the free-tier quota for `gemini-3.5-flash` was exhausted during the session and
`gemini-3-flash-preview` / `gemini-3.1-pro-preview` were rate-limited most of the time, so almost every call ran on
`gemini-3.1-flash-lite` (the weakest model) — a good stress test for the weak-model aids. Checks ran in the real runtime image.

| run | mode / path | result | time | LLM calls · tokens | fix iterations | notes |
|---|---|---|---|---|---|---|
| (a) "Build a landing page for a coffee shop with menu and contact form" | build, in-process (`scripts/builder-agents-e2e.ts`) | **SUCCEEDED** — typecheck, lint, `next build` green | 483 s | 21 · 97 k | 1 (lint `react/no-unescaped-entities`) | 3 rate-limit failures waited out; designer blocked from writing `app/page.tsx` (allow-list); hero + menu section + zod/react-hook-form contact form with toasts, metadata |
| (b) "Add a todo app with login where each user sees only their own todos" | build, in-process, real LevantBase | **SUCCEEDED** — checks green | 374 s | 49 · 318 k | 1 (lint `no-explicit-any`) | backend created & ACTIVE in 33 s; migration `create_todos_table` applied + saved (RLS on, 4 per-operation policies for `authenticated`); `lib/database.types.ts`; `/login` (sign-in/up), sign-out, `/todos` server-protected. **supabase-js verification 10/10** (`scripts/builder-agents-verify-rls.ts`): own rows only, cross-user insert (42501) / update / delete denied, anon sees nothing. Preview: `/login` 200, `/todos` 307 → `/login` signed out, `/` 200 |
| (c) follow-up edit on (a): "Add a 'Today's specials' section above the menu … make View Menu scroll to the menu" | build via **queue `builder` + worker + SSE**, worker **SIGKILLed mid-coding** and restarted | **SUCCEEDED** — checks green | 151 s (incl. ~100 s down) | 12 · 47 k | 1 (lint) | `resumes: 1`: completed plan skipped, coder resumed from its checkpoint; the SSE client reconnected with `after=<seq>` and saw a gap-free stream (#1…#35) |
| cancel a RUNNING run via the worker | `cancelRun` | **CANCELED** in 311 ms | — | — | — | in-flight LLM call aborted, partial work committed, "Stopped…" reply |
| chat: "Which sections does my home page have, and where is the contact form handled?" | chat | **SUCCEEDED** | 3 s | 3 | — | read `app/page.tsx` + `contact-form.tsx`, correct answer, no commit |

Findings fixed during the live runs: (1) step retries gave up within seconds when every Gemini model was cooling down → global
cooldowns now wait with backoff (≤ 4 min/step) and parallel coders are only used with ≥ 2 providers; (2) the resume sweep picked up an
in-process run → per-run execution lease (Redis, 60 s TTL + heartbeat); (3) the designer overwrote pages → write allow-list; (4) lint
linted `.levant/build-check` (see request to builder-core). Remaining quality gap with flash-lite: generated components sometimes use raw
Tailwind palette classes (`bg-stone-900`, `text-amber-600`) instead of the theme tokens despite the prompt.

Cleanup: the (b) backend `iuviyvgeizqdauavtnvh` is PAUSED, my preview containers and worker are stopped; workspaces stay in
`control/storage-bagents/` (DB `levantdeploy_bagents`).
