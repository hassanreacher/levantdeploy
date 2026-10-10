# LevantBase — client compatibility report

**Result: 103/103 checks passed** (0 failed, 0 skipped) — run of 2026-10-10 13:52 UTC against a Base project
created through the LevantDeploy API and reached over **HTTPS through LevantDeploy's Caddy** (local CA, certificate
verified) with the official client library — no mocks, no internal shortcuts.

Suite: [`control/tests/base/compat/`](../control/tests/base/compat/) · how to run: [Running it](#running-it) ·
fixes made because of it: [docs/requests/compat.md](requests/compat.md) · user guide: [BASE.md](BASE.md).

## Versions

| Client | Version |
|---|---|
| `@supabase/supabase-js` (exact pin) | 2.117.3 |
| auth-js / postgrest-js / realtime-js / storage-js / functions-js | 2.117.3 / 2.117.3 / 2.117.3 / 2.117.3 / 2.117.3 |
| Node.js | v22.22.2 |

| Server component (per project) | Image |
|---|---|
| db | `supabase/postgres:17.6.1.136` |
| auth | `supabase/gotrue:v2.196.0` |
| meta | `supabase/postgres-meta:v0.99.0` |
| rest | `postgrest/postgrest:v14.17` |
| pooler | `supabase/supavisor:2.9.12` |
| studio | `supabase/studio:2026.09.07-sha-7996410` |
| gateway | `envoyproxy/envoy:v1.39.1` |
| storage | `supabase/storage-api:v1.74.0` |
| imgproxy | `darthsim/imgproxy:v3.31.4` |
| realtime | `supabase/realtime:v2.134.10` |
| functions | `supabase/edge-runtime:v1.76.2` |

Platform: LevantDeploy control (Next.js 15) + worker, Caddy 2 (`caddy:2-alpine`), Docker 29 / compose v5, upstream
self-hosting stack vendored at the commit in `base-stack/upstream/UPSTREAM.txt`.

## Summary

| Area | Passed |
|---|---|
| platform | 3/3 |
| auth | 18/18 |
| database | 21/21 |
| realtime | 8/8 |
| storage | 20/20 |
| functions | 12/12 |
| graphql | 4/4 |
| keys | 9/9 |
| auth-email | 8/8 |

Coverage: auth (sign-up with auto-confirm and with email confirmation through SMTP, password sign-in, getUser,
updateUser, refresh, sign-out, admin create/list/get/update/delete, generateLink magic link + recovery, OTP by mail,
anonymous sign-in), database (DDL + RLS through the platform SQL API, select/insert/update/delete/upsert, filters,
order, range, count, embedded relations, rpc, RLS isolation between users, service_role vs anon), realtime
(postgres_changes INSERT/UPDATE/DELETE with RLS, broadcast over the socket and REST, presence), storage (public/private
buckets, upload/download/list/copy/move/remove, signed URLs and signed uploads, public URLs, imgproxy transformations,
MIME restriction, RLS policies on `storage.objects`), edge functions (deploy through the platform, invoke with user JWT
/ anon / no key, verify_jwt on and off, secrets, error status, function → REST), GraphQL (queries, relations,
mutations, RLS), key separation and `/pg` refusal.

## All checks

| # | Area | Check | Result | Detail |
|---|---|---|---|---|
| 1 | platform | create a Base project via POST /api/v1/base/projects | PASS | stbnwixjtnvulwrbcwrp ACTIVE after 25 s |
| 2 | platform | project API reachable over HTTPS through Caddy (verified certificate) | PASS |  |
| 3 | platform | schema, RLS policies, functions, publication via POST …/sql | PASS |  |
| 4 | auth | signUp (email + password, autoconfirm) returns a session | PASS | user f21b3382…, confirmed_at set: true |
| 5 | auth | signInWithPassword | PASS | expires_in 3600s |
| 6 | auth | signInWithPassword with a wrong password is rejected | PASS | Invalid login credentials |
| 7 | auth | getUser (JWT validated by the server) | PASS |  |
| 8 | auth | updateUser (metadata) | PASS |  |
| 9 | auth | updateUser (password) → login with the new password | PASS |  |
| 10 | auth | refreshSession returns a new access token | PASS | refresh token rotated |
| 11 | auth | signOut revokes the refresh token | PASS | Invalid Refresh Token: Refresh Token Not Found |
| 12 | auth | getSession is empty after signOut | PASS |  |
| 13 | auth | admin.createUser (email_confirm) with service_role key | PASS |  |
| 14 | auth | admin.listUsers finds the created user | PASS | 4 users |
| 15 | auth | admin.getUserById + updateUserById | PASS |  |
| 16 | auth | admin API refused with the anon key | PASS | 403 User not allowed |
| 17 | auth | admin.generateLink magiclink → verifyOtp(token_hash) signs in | PASS | action_link on the project URL |
| 18 | auth | admin.generateLink recovery → verifyOtp(email OTP) signs in | PASS |  |
| 19 | auth | action_link redirect (GET /auth/v1/verify) hands out tokens in the URL fragment | PASS | 303 → redirectTo#access_token=… |
| 20 | auth | admin.deleteUser | PASS |  |
| 21 | auth | anonymous sign-in refused while disabled (default) | PASS | Anonymous sign-ins are disabled |
| 22 | database | PostgREST sees the new tables after `notify pgrst, 'reload schema'` | PASS |  |
| 23 | database | select with filters (eq / gt / in / ilike / or) + order | PASS |  |
| 24 | database | range + count: 'exact' | PASS |  |
| 25 | database | head count (count only, no rows) | PASS |  |
| 26 | database | single() / maybeSingle() | PASS |  |
| 27 | database | embedded relations (many-to-one and one-to-many) | PASS |  |
| 28 | database | rpc() to SQL functions (scalar + with table access) | PASS |  |
| 29 | database | rpc() sees the caller's JWT (auth.uid(), auth.role()) | PASS |  |
| 30 | database | insert (returning) as a signed-in user | PASS |  |
| 31 | database | update with filter + returning | PASS |  |
| 32 | database | upsert (on conflict) inserts then updates | PASS |  |
| 33 | database | delete with filter | PASS |  |
| 34 | database | RLS: another user cannot see the rows | PASS |  |
| 35 | database | RLS: another user cannot update or delete the rows | PASS |  |
| 36 | database | RLS: inserting a row for another user is refused (WITH CHECK) | PASS |  |
| 37 | database | RLS: anon cannot read or write user tables | PASS | insert → 42501 |
| 38 | database | service_role bypasses RLS | PASS |  |
| 39 | database | PostgREST error shape (unknown column → 42703 / PGRST) | PASS | 42703 |
| 40 | database | objects created through the SQL API belong to `postgres` (hosted SQL-editor semantics) | PASS |  |
| 41 | database | platform SQL API runs DDL/DML and returns rows | PASS |  |
| 42 | database | typed client against a fresh connection (no session) still works | PASS |  |
| 43 | realtime | subscribe to postgres_changes (authenticated, RLS-checked) + system 'Subscribed to PostgreSQL' | PASS | ready after 1146 ms |
| 44 | realtime | postgres_changes INSERT received | PASS |  |
| 45 | realtime | postgres_changes UPDATE received (with old record — replica identity full) | PASS |  |
| 46 | realtime | postgres_changes DELETE received | PASS |  |
| 47 | realtime | postgres_changes respects RLS (anon listener gets no rows) | PASS |  |
| 48 | realtime | broadcast between two clients | PASS |  |
| 49 | realtime | broadcast via REST (httpSend, no socket) | PASS |  |
| 50 | realtime | presence sync between two clients | PASS | join + leave seen |
| 51 | storage | createBucket (public) with service_role | PASS |  |
| 52 | storage | createBucket (private) + getBucket + listBuckets | PASS |  |
| 53 | storage | createBucket refused for anon | PASS |  |
| 54 | storage | storage RLS policies created via SQL (per-user folder in the private bucket) | PASS |  |
| 55 | storage | upload as a user into the own folder | PASS |  |
| 56 | storage | download returns identical bytes | PASS |  |
| 57 | storage | list folder | PASS |  |
| 58 | storage | upload with upsert replaces the object | PASS |  |
| 59 | storage | copy + move | PASS |  |
| 60 | storage | storage RLS: another user cannot read, list or overwrite | PASS | upload → 403 |
| 61 | storage | private bucket refused for anon | PASS |  |
| 62 | storage | createSignedUrl + fetch (no auth header) | PASS |  |
| 63 | storage | createSignedUploadUrl + uploadToSignedUrl | PASS |  |
| 64 | storage | upload to the public bucket (service_role) | PASS |  |
| 65 | storage | public URL fetch (no key) | PASS |  |
| 66 | storage | bucket mime-type restriction enforced | PASS |  |
| 67 | storage | image transformation via imgproxy (/render/image, resize 60x40) | PASS | png 60x40 |
| 68 | storage | image transformation on a signed URL (private object) | PASS |  |
| 69 | storage | remove objects | PASS |  |
| 70 | storage | emptyBucket + deleteBucket | PASS |  |
| 71 | functions | deploy two functions via the platform API (verifyJwt on / off) | PASS |  |
| 72 | functions | set a function secret via the platform API | PASS | names listed, values never returned |
| 73 | functions | functions.invoke with the user's JWT (POST JSON body) | PASS |  |
| 74 | functions | env secret visible inside the function | PASS |  |
| 75 | functions | functions.invoke with the anon key (verify_jwt accepts the anon JWT) | PASS |  |
| 76 | functions | verify_jwt on: no / forged Authorization → 401 | PASS |  |
| 77 | functions | verify_jwt off: invocable without any key | PASS |  |
| 78 | functions | function error status surfaces as FunctionsHttpError | PASS |  |
| 79 | functions | function reaches the project's REST API (SUPABASE_URL + SUPABASE_ANON_KEY) | PASS |  |
| 80 | functions | platform invoke tester (POST …/functions/:slug/invoke) | PASS |  |
| 81 | functions | unknown function → 404 | PASS |  |
| 82 | functions | delete a function via the platform API | PASS |  |
| 83 | graphql | pg_graphql query through /graphql/v1 (anon, RLS-filtered) | PASS |  |
| 84 | graphql | GraphQL relationships + filter | PASS |  |
| 85 | graphql | GraphQL with a user JWT respects RLS | PASS | user 2 rows, anon 0 |
| 86 | graphql | GraphQL mutation (insertInto…Collection) as a user | PASS |  |
| 87 | keys | requests without an apikey are refused (REST, Auth, GraphQL → 401; Storage → 4xx) | PASS | 401 / 401 / 401 / 400 |
| 88 | keys | a key signed with another secret is refused | PASS |  |
| 89 | keys | service_role: full access (bypasses RLS, admin APIs, OpenAPI root) | PASS |  |
| 90 | keys | anon: OpenAPI root not exposed | PASS | 403 |
| 91 | keys | /pg (postgres-meta) refused for anon, allowed for service_role | PASS |  |
| 92 | keys | API host serves no Studio (/ → 404) | PASS |  |
| 93 | keys | platform API: anon key public (VIEWER), service key requires ADMIN reveal | PASS |  |
| 94 | keys | platform API: unknown project → 404, no token → 401 | PASS |  |
| 95 | keys | auth settings endpoint (public) reflects the project config | PASS | mailer_autoconfirm=true |
| 96 | auth-email | switch settings via the platform API: confirmations on, SMTP, anonymous users, custom template | PASS | mailer_autoconfirm=false, anonymous_users=true |
| 97 | auth-email | signUp with confirmations on → no session, confirmation mail delivered | PASS |  |
| 98 | auth-email | signIn before confirming → 'Email not confirmed' | PASS |  |
| 99 | auth-email | confirmation link from the mail → redirect with tokens, then signIn works | PASS |  |
| 100 | auth-email | signInWithOtp → code from the custom mail template → verifyOtp | PASS | template served by the gateway to GoTrue |
| 101 | auth-email | resetPasswordForEmail → recovery mail | PASS |  |
| 102 | auth-email | signInAnonymously (enabled in settings) | PASS |  |
| 103 | auth-email | restore defaults (autoconfirm on, no SMTP, anonymous off) | PASS |  |

## CLI (`levant base …`) — run against a real project

| Command | Result |
|---|---|
| `base ls` / `base link <ref>` / `base status` | PASS — project table, `.levant/base.json` written, status + per-service state and image |
| `base create cli-made --project demo-app` | PASS — created through the API, waited for ACTIVE, `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_ANON_KEY` added to the Deploy project, folder linked |
| `base keys` / `base keys --service` | PASS — anon key; service key with the RLS warning (admin token) |
| `base env pull` | PASS — 8 variables merged into an existing `.env.local` (existing keys replaced in place, others kept, mode 0600) |
| `base db push --dry-run` / `db push --yes` (twice) | PASS — 2 pending listed; applied in order (~0.4 s each), tracked in `levant.levant_migrations`; second run "up to date" |
| `base db push` with a failing file | PASS — "failed (rolled back)", nothing from the file left behind, history unchanged, exit 1 |
| `base sql "…"` | PASS — result table |
| `base db url` | PASS — pooler URL (`base-<ref>:6543`), password masked, hint about the public port |
| `base db dump -f dump.sql` | PASS — 201 KB SQL (auth, public, storage, levant schemas) via backup + download |
| `base gen types typescript` | PASS — `Database` type with the migrated tables and enum (postgres-meta generator via the new `GET …/types`) |
| `base functions deploy` (all; `../_shared` import; `config.toml` `verify_jwt = false`) / `ls` / `rm` | PASS — 2 functions, "+1 _shared file", webhook deployed without JWT verification, deleted |
| `base secrets set` / `ls` / `unset` | PASS — names only; the function sees the new value after the runtime restart |
| `base functions invoke hello-cli -d '{"name":"Levant"}'` | PASS — `200 · 33 ms {"message":"Hello Levant!","secret":"from-cli"}` |
| `base functions invoke … --no-auth` / `--service` | **request** — the platform invoke endpoint ignores the `auth` choice (always anon), see requests/compat.md |
| `base studio` | PASS (fallback) — Studio SSO links are issued to dashboard sessions only, so the CLI opens the project page |

Unit tests: `cli/test/base.test.ts` — 16 tests (migration ordering / planning / transactions / splitting, SQL
splitter, env merge, function bundling with `_shared`, `config.toml`, a `db push` run against a fake API).

## Notes on behaviour (same as upstream / hosted)

- `/storage/v1/*` has no key check at the gateway (public objects are served without a key, as upstream); the storage
  server itself refuses an unauthenticated bucket listing (`400`). REST, Auth and GraphQL answer `401` without a key.
- GoTrue sends at most one mail per address per minute (`over_email_send_rate_limit`) — the suite uses separate
  addresses for OTP and recovery mails.
- `postgres_changes`: wait for the `system` message *Subscribed to PostgreSQL* (≈ 1–3 s after `SUBSCRIBED` on a fresh
  project) before relying on events; changes made earlier are not delivered.
- `/graphql/v1` needs `pg_graphql` — enabled on new projects since this suite (fix #1 in requests/compat.md).
- SQL through the platform (SQL editor, `levant base sql`, `db push`, AI agent) runs as `postgres`, like hosted
  projects (fix #4) — objects stay alterable by apps and migration tools that connect as `postgres`.

## Running it

```bash
cd control/tests/base/compat && npm install
# dev sandbox (Caddy container, local CA, SMTP sink container) — see run.sh:
LB_API=http://localhost:3111 LB_TOKEN=ld_… ./run.sh                 # creates a project, runs everything, deletes it
LB_API=… LB_TOKEN=… LB_REF=<ref> ./run.sh                           # against an existing project
# against a real server (public DNS + real certificates; without an SMTP sink the email checks are skipped):
LB_API=https://deploy.example.com LB_TOKEN=ld_… ../../../node_modules/.bin/tsx run.ts
```
Exit code = number of failed checks; `results/latest.md` and a JSON report are written next to the suite.
