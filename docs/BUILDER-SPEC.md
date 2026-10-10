# LevantDeploy Builder — AI app builder (Lovable-style) inside LevantDeploy (read this first)

Part of the SAME product/codebase (control app, same login/teams/plans/dashboard/CLI/AI agent/installer). A user describes an app in plain language; a team of AI agents builds a full-stack **Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui** app, backed by the project's **LevantBase backend** (Postgres/Auth/Storage/Realtime/Functions via supabase-js), shows a **live preview**, lets non-programmers edit it **visually (click to select, edit text inline, drag-and-drop sections, style panel, component library, image replace — WordPress-like)** or by chatting, keeps **version history**, and **publishes** it as a LevantDeploy project (URL + custom domains). Never push to git remotes. NEVER write provider API keys into the repo, logs, screenshots, docs or test fixtures — keys come only from env or the encrypted platform setting; during development they are in `/home/user/.levant-secrets/providers.env` (outside the project, chmod 600) — load with `set -a; . file; set +a` in your shell only.

## LLM providers (all must be supported; owner configures keys in Settings → AI providers (encrypted) or env)
OpenAI-compatible chat/completions with streaming + tool calling where supported:
| id | base URL | env key | notes |
|---|---|---|---|
| gemini | https://generativelanguage.googleapis.com/v1beta/openai | GEMINI_API_KEY | live-tested in sandbox; models e.g. gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-flash-lite, gemini-3.1-pro-preview (older 2.5 are retired for new keys → 404) |
| groq | https://api.groq.com/openai/v1 | GROQ_API_KEY | 30 RPM, 1000 req/day/model |
| openrouter | https://openrouter.ai/api/v1 | OPENROUTER_API_KEY | `:free` models |
| mistral | https://api.mistral.ai/v1 | MISTRAL_API_KEY | |
| nvidia | https://integrate.api.nvidia.com/v1 | NVIDIA_API_KEY | |
| cerebras | https://api.cerebras.ai/v1 | CEREBRAS_API_KEY | optional (empty) |
| cloudflare | https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1 | CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID | Workers AI OpenAI-compatible |
| ollama | https://ollama.com/v1 | OLLAMA_API_KEY | Ollama cloud |
| unorouter | https://api.unorouter.com/v1 | UNOROUTER_API_KEY | 190+ free models, 1 req/min each → rotate models |
| orcarouter | https://api.orcarouter.ai/v1 | ORCAROUTER_API_KEY | |
| kilo | https://api.kilocode.ai/api/openrouter | KILO_API_KEY | OpenRouter-compatible gateway |
| pollinations | https://text.pollinations.ai/openai | POLLINATIONS_KEY | |
| llm7 | https://api.llm7.io/v1 | LLM7_API_KEY | |
| logfare | https://api.logfare.ai/v1 | LOGFARE_API_KEY | LOGS PROMPTS → disabled by default, owner opt-in with warning |
| ovh | OVH AI Endpoints | OVH_AI_ENDPOINTS_TOKEN | optional |
| anthropic | existing `@anthropic-ai/sdk` integration (src/lib/ai) | ANTHROPIC_API_KEY | optional premium provider |
Base URLs/model ids must be configurable per provider (owner can edit/add any OpenAI-compatible provider). In THIS sandbox only Gemini's host is reachable (network policy) — others are implemented from their public docs and verified with a local fake OpenAI-compatible server; never present fake results as real.

## Architecture
- Data (Prisma, additive): `BuilderProject` (teamId, projectId? (Deploy project) @unique, baseRef?, name, template, status, previewStatus, settings Json (knowledge/custom instructions, theme), lastCommit), `BuilderMessage` (role user/assistant/system, content, attachments, commitSha, agentRunId), `BuilderRun` (status QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELED, plan Json, steps, provider usage, error), `BuilderRunEvent` (stream), `LlmUsage`, `AiProviderConfig` (stored in Setting encrypted).
- Workspace: `STORAGE_DIR/builder/{id}/repo` — a real git repo (local only, never pushed unless the user exports to GitHub through the git area's app). Every agent turn and every visual edit = a commit; restore = new commit reverting to that tree.
- Template: `builder-template/next15/` (Next.js 15 App Router, TS strict, Tailwind, shadcn/ui components pre-generated, lucide-react, supabase-js client `lib/supabase.ts` reading NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, `levant-bridge` dev-only script for visual editing, ESLint). A **runtime image** `levant/builder-runtime:next15` with the template's node_modules pre-installed (pnpm store) for fast previews; extra deps installed on demand (`pnpm add`) through the build proxy/egress settings.
- Source mapping for visual editing: dev-only SWC/Babel transform adds `data-lv-src="path:line:col"` to JSX host elements (webpack mode for preview dev server); the bridge script handles hover/select overlay, inline text editing (contenteditable on text-only nodes), drag handles for reordering siblings, and postMessage to the editor. Server applies edits as **AST transforms** (babel parser + recast to keep formatting) — text change, className/style change, attribute change (img src/alt, link href), move/reorder sibling, duplicate, delete, insert component (from library) — then commits.
- Preview: per builder project a container `lvb_{id}` (runtime image, workspace bind-mounted, `next dev` with HMR) on `levant_net`, routed by Caddy at `preview-{id}.{PLATFORM_DOMAIN}` behind a session gate (forward_auth like Studio; share links create read-only signed tokens), idle-stop after 20 min, restart on demand; dev server logs + browser console errors (bridge forwards runtime errors) are captured for the agents.
- Agents run on the **worker** (queue `builder`), keep going if the browser closes, stream events via Redis pub/sub → SSE. Roles: **Planner** (spec + file plan + data model), **Designer** (design system/theme, layout), **Coder(s)** (file edits via tools), **Backend agent** (creates/attaches LevantBase backend, writes SQL migrations with RLS, storage buckets, auth pages, edge functions), **Reviewer/Fixer** (runs `tsc`, `next lint`, `next build` check in the preview container, reads preview runtime errors, fixes until green, max N iterations), **Judge** (best-of-N: for critical steps generate candidates with different providers/models and pick the best). Tools: list_files, read_file, write_file, apply_patch (search/replace blocks), delete_file, rename_file, add_dependency, run_check (typecheck|lint|build), get_preview_errors, screenshot_preview (optional, Playwright not in worker → skip), base_sql (via LevantBase runSql, approval not needed inside builder sandbox project but audited), base_create_bucket, deploy_function, search_docs (bundled shadcn/next/supabase-js cheat sheets).
- **Router & resilience**: every agent call goes through `src/lib/llm` — provider/model catalog with capabilities (tools, vision, context, speed), health scores, per-provider rate-limit tracking (429/503 → cool-down), automatic fallback to the next provider/model mid-task (resume from the last completed tool step — conversation state is provider-agnostic), retries with backoff, JSON/tool-call repair for weaker models, token budgets, usage accounting (`LlmUsage`). If all providers fail → run FAILED with a clear message and the workspace stays at the last good commit.
- Publish: "Publish" creates/updates the Deploy project (`BuilderProject.projectId`) and a production deployment from the repo HEAD (tarball → existing upload/build pipeline; framework nextjs); env vars from the backend connected automatically; custom domain via existing Domains UI. Also: download ZIP, export to GitHub (via the git area's GitHub App, new repo + push), import from GitHub/zip later.
- Credits/limits (plans lib): builder messages per day/month per plan (Hobby: 5/day & 30/month like Lovable free; Pro: 100/month + 5/day; Team: 500/month), max builder projects (Hobby 5), preview hours. Enforced via plans (`assertCanUseBuilder(teamId)`).

## Areas (wave E)
| area | owns |
|---|---|
| llm | `src/lib/llm/**` (providers, catalog, router, health, fallback, ensemble/judge helpers, usage), Settings → AI providers UI + API (owner), tests with a fake OpenAI-compatible server + live Gemini |
| builder-core | Prisma builder models, `builder-template/**`, runtime image Dockerfile, `src/lib/builder/{workspace,git,template,preview,visual-edit,publish,export}.ts`, preview routing/gate (extend proxy additively), file & version & visual-edit & publish APIs `/api/v1/builder/**` (non-agent parts), worker processor for preview lifecycle |
| builder-agents | `src/lib/builder/agents/**`, worker processor `builder` (runs), run APIs (start/cancel/stream), prompts, tools, fix loop, backend agent, best-of-N |
| builder-ui | all builder UI: home "What do you want to build?" prompt (dashboard + landing CTA), builder editor (chat, preview, code, visual edit mode, history, publish, settings/knowledge, backend panel), templates gallery, project list; plans credits UI hooks |
| (later) e2e + landing | real end-to-end builds with live Gemini, landing/pricing update, docs `docs/BUILDER.md` |
