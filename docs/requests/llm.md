# llm area — LLM router (`control/src/lib/llm`)

Status: API stable (types in `src/lib/llm/types.ts`, entry `src/lib/llm/index.ts`). Worker-safe (no `next/*`, no `server-only`).

## Usage

```ts
import { llm, type LlmMessage, type LlmTool, LlmError } from "@/lib/llm";

// 1. one-shot (non-stream or stream — events go to onEvent either way)
const r = await llm.chat({
  purpose: "code",                       // plan | code | fix | judge | chat | vision | fast
  messages: [{ role: "system", content: "…" }, { role: "user", content: "…" }],
  tools,                                 // LlmTool[] (OpenAI function format: name, description, parameters JSON schema)
  toolChoice: "auto",                    // auto | none | required | { name }
  maxTokens: 4000, temperature: 0.2,
  signal,                                // AbortSignal → LlmError("ABORTED")
  teamId, runId,                         // usage accounting (LlmUsage rows)
  onEvent: (e) => publish(e),            // unified events, see below
});
r.text; r.toolCalls /* [{ id, name, arguments: JSON string, input: object|null }] */; r.finishReason; r.provider; r.model; r.usage; r.attempts;

// 2. streaming iterator (returns the LlmResult as the generator's return value)
for await (const e of llm.stream({ purpose: "chat", messages })) { … }

// 3. JSON output
const plan = await llm.chat({ purpose: "plan", messages, jsonSchema: { name: "plan", schema } });  // plan.json = parsed object

// 4. best-of-N on N different providers in parallel, then judge
const items = await llm.ensemble({ candidates: 3, purpose: "code", messages });   // [{ index, ok, result | error }]
const okOnes = items.filter((i) => i.ok);
const verdict = await llm.judge("Write the hero section …", okOnes.map((i) => i.result.text), { criteria: "correctness, TS strictness" });
verdict.winner; verdict.scores; verdict.reasoning;
```

Tool loop (caller-owned; conversation is provider-agnostic so any step may run on a different model):

```ts
messages.push({ role: "assistant", content: r.text || null, toolCalls: r.toolCalls });
for (const c of r.toolCalls) messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: JSON.stringify(await run(c.name, c.input)) });
```
`c.input === null` means the arguments could not be repaired into JSON — send the error back as the tool result so the model retries.

### Events (`LlmEvent`)
| type | payload | meaning |
|---|---|---|
| `provider` | provider, model, attempt | an attempt starts on this model |
| `text` | text | text delta |
| `tool_call` | call (complete, repaired) | one per tool call |
| `usage` | usage {inputTokens, outputTokens} | |
| `retry` | provider, model, code, message, restart, attempt, delayMs | attempt failed; **`restart: true` ⇒ discard everything streamed so far for this request** (the whole request re-runs on the next model) |
| `done` | result | final |
| `error` | code, message | all candidates failed (chat() also throws `LlmError`) |

### Errors
`LlmError.code`: `NO_PROVIDERS` (nothing enabled/configured — tell the owner to open Settings → AI providers), `ALL_FAILED` (`err.attempts` lists each try),
`ABORTED`, plus per-attempt codes `RATE_LIMITED | OVERLOADED | TIMEOUT | NETWORK | AUTH | NOT_FOUND | BAD_REQUEST | SERVER | STREAM_BROKEN | INVALID_OUTPUT`.

### Request options (beyond the above)
`model: "provider/model"` (prefer that model first) + `pinOnly: true` (no fallback) · `providers: ["gemini", "groq/llama-3.3-70b-versatile"]` allow-list ·
`exclude: [...]` · `timeoutMs` (per attempt: first byte and idle gap; default 60 s) · `maxAttempts` (default 6) · `json: true` (JSON object mode) · `stream: false`.

### Routing
1. Candidates = the owner's ranked preference list for the purpose (Settings → AI providers → "Model preferences"), then every other enabled
   model that fits (tools needed? vision needed (image parts)? context window), smart tier first for plan/code/fix/judge, fast tier first for fast/chat.
2. Skipped: disabled / unconfigured providers, models in cooldown, provider or model over its RPM/RPD budget.
3. Order within the list is adjusted by health (success rate < 50 % with ≥ 4 samples → moved to the end).
4. Rotation providers (`unorouter`, 1 req/min/model) — the least recently used free model of that provider is picked.
5. Failure → classify → cooldown (429/quota/"high demand"/503 → `Retry-After` or 60 s, growing; 401/403 → provider 10 min; 404 → model 1 h) →
   jittered backoff (transient errors may retry the same model once) → next candidate. Mid-stream failure → `retry` event with `restart: true`.
6. Every attempt writes one `LlmUsage` row (provider, model, purpose, tokensIn/Out, latencyMs, ok, errorCode, teamId, runId).

### Helpers
- `llm.candidates({ purpose, tools?, vision? })` → ranked refs that would be tried now (debug / UI).
- `llm.providers()` → `LlmProviderView[]` (keys masked).
- `llm.test(providerId, model?)` → `{ ok, model, latencyMs, text?, error? }` (1-token request).
- `parseToolCallsFromText(text)`, `repairJson(text)` — exported for other areas.
- `createRouter({ ... })` — the router with injectable config/store/usage (tests).

## Providers
All rows of the BUILDER-SPEC table are built in (`src/lib/llm/catalog.ts`): gemini, groq, openrouter, mistral, nvidia, cerebras, cloudflare, ollama, unorouter,
orcarouter, kilo, pollinations, llm7, logfare (disabled by default — logs prompts), ovh, anthropic (`@anthropic-ai/sdk`). The owner can add any
OpenAI-compatible provider (custom id, base URL, key, headers, models).
Keys: Setting `llm.providers[id].apiKeyEnc` (encryptString) > env (`GEMINI_API_KEY`, …). Anthropic additionally falls back to `ai.apiKeyEnc` (Settings → AI).

## Platform API (owner only, `requirePlatformOwner`)
```
GET    /api/v1/platform/ai-providers                       → { providers: LlmProviderView[] (with status + health), preferences, routing, purposes }
POST   /api/v1/platform/ai-providers                       { id, label, baseUrl, apiKey?, headers?, models? } → add custom provider
PATCH  /api/v1/platform/ai-providers/:id                   { enabled?, apiKey? ("" clears), baseUrl?, headers?, vars?, models?, modelOverrides?, limits?, label? }
DELETE /api/v1/platform/ai-providers/:id                   custom: delete; built-in: reset overrides
POST   /api/v1/platform/ai-providers/:id/test              { model? } → { ok, model, latencyMs, text?, error? }
POST   /api/v1/platform/ai-providers/:id/models            refresh /models → { models }
GET    /api/v1/platform/ai-providers/health                → { providers: [{ id, status, health }], items: LlmHealth[] } (live status dots, polled every 10 s)
POST   /api/v1/platform/ai-providers/health/reset          { scope? } clear cooldowns/health
GET|PUT /api/v1/platform/ai-providers/preferences          { preferences: Record<purpose, string[]>, routing? }
GET    /api/v1/platform/ai-providers/usage?range=24h|30d   → { rows: [{ provider, model, requests, ok, errors, inputTokens, outputTokens, avgLatencyMs }], errors: [...] }
```

## Shared-file changes (additive)
- `prisma/schema.prisma`: new model `LlmUsage` (no relations).
- `src/lib/settings.ts`: keys `llm.providers`, `llm.preferences`, `llm.routing`, `llm.modelsCache`.
- `src/app/(dashboard)/settings/sections.ts`: "AI providers" section.

## Implementation notes
- Files: `types.ts` (public types) · `index.ts` (`llm` singleton + exports) · `catalog.ts` (providers, default preferences) · `config.ts` (pure resolution:
  overrides + env + /models cache → providers/views) · `router.ts` (ranking, failover, retries, ensemble, judge, test) · `health.ts` (Redis/memory KV:
  health, cooldowns, RPM/RPD counters, rotation LRU) · `openai.ts` / `anthropic.ts` (adapters) · `repair.ts` (JSON + text tool-call repair) · `sse.ts` ·
  `runtime.ts` (production wiring: Setting table, Redis `REDIS_URL`, `LlmUsage`) · `admin.ts` (owner operations used by the API/page).
- Gemini 3: tool calls carry `extra_content.google.thought_signature`; it is kept in `LlmToolCall.extra` and echoed back automatically. Tool calls made by
  another provider get the documented bypass signature, so a run can switch to Gemini mid-conversation (verified live). `fast`/`chat` purposes send
  `reasoning_effort: "minimal"` (with `low`, gemini-3-flash-preview can spend a small budget entirely on thinking and return nothing).
  Output tokens include thinking tokens (`max(completion, total − prompt)`).
- Models without native tools (`tools: false`) get the tools described in the system prompt and answer with `<tool_call>{…}</tool_call>`; text is
  buffered for those (no raw markup is streamed). Native-tool models that still write calls as text are repaired the same way.
- Anthropic: SDK retries off (router owns retries), no `temperature` (rejected by current models), forced `tool_choice` → `auto` + instruction,
  JSON via `output_config.format`, effort per purpose (plan/judge high, code/fix medium, chat/fast low).
- Keys never leave the server: views carry `keyHint` (`••••` + last 4); error messages are scrubbed (`scrubSecrets`) before they reach health, logs,
  `LlmUsage.error` or API responses.
- Behind an HTTPS proxy, Node's fetch needs `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) — production servers don't need it; the live-check script sets it.

## Live results (sandbox, 2026-10-10)
`npx tsx scripts/llm-live-check.ts [--deep]`:
| provider | result |
|---|---|
| gemini | **OK** — gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-flash-lite: chat, SSE streaming, native tool call, tool-result round-trip (thought signatures), JSON schema, vision; foreign tool call → Gemini round-trip OK. Live failover observed (3.5-flash 429 → 3-flash-preview). gemini-2.5-flash → `NOT_FOUND` ("no longer available to new users") as expected. |
| groq, openrouter, mistral, nvidia, cloudflare, ollama, unorouter, orcarouter, kilo, pollinations, llm7 | **unreachable from sandbox** — the sandbox proxy refuses the connection (`Request was cancelled`), not a key problem. Implemented from public docs and covered by the fake-server tests. |
| logfare | disabled by default (logs prompts) — not called |
| cerebras, ovh, anthropic | no key in providers.env |

Screenshots: `docs/screenshots/llm/` (providers list with live status, Gemini expanded with Test result, Logfare confirm dialog, preferences, usage, mobile light).

## Testing
- `scripts/fake-openai.ts` — local OpenAI-compatible server (SSE) with scenarios: ok, tool calls (native / as text / fenced), 429 with Retry-After,
  503, timeout, broken stream, high-demand body, invalid JSON. Unit tests `src/lib/llm/llm.test.ts` start it in-process.
- `scripts/llm-live-check.ts` — `set -a; . /home/user/.levant-secrets/providers.env; set +a; npx tsx scripts/llm-live-check.ts` prints
  provider/model/ok/latency/error for every configured provider (keys never printed).
