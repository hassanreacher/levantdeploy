# LevantBase — backends on your LevantDeploy server

LevantBase gives every team **Base projects**: a dedicated Postgres database with Auth, an auto-generated REST and
GraphQL API, Realtime, Storage with image transformations, Edge Functions and a database Studio. Each project runs its
own copy of the official open-source self-hosting stack (Apache-2.0) on your server — nothing is sent to a hosted
service. Because the same server components run, apps use the standard open-source client libraries
(`@supabase/supabase-js`, `supabase_flutter`, `supabase-py`, `supabase-swift`, `supabase-kt` — MIT) unchanged; only the
URL and the keys are yours. Compatibility is checked by a real client suite: see [BASE-COMPAT.md](BASE-COMPAT.md).

Contents: [1 Create a backend](#1-create-a-backend) · [2 Connect a Deploy project](#2-connect-a-deploy-project) ·
[3 Use it from code](#3-use-it-from-code) · [4 Auth](#4-auth-providers-and-smtp) · [5 RLS cookbook](#5-row-level-security-cookbook) ·
[6 Storage](#6-storage) · [7 Realtime](#7-realtime) · [8 Edge Functions](#8-edge-functions) ·
[9 Migrations & CLI](#9-migrations-and-the-cli) · [10 Backups](#10-backups) · [11 Limits](#11-limits-per-plan) ·
[12 Migrating an existing project](#12-migrating-an-existing-project) · [13 Architecture & security](#13-architecture-and-security-model)

---

## 1. Create a backend

**Dashboard**: team → **Base** → **New project** (name, optional database password, optionally the Deploy project that
owns it). Provisioning takes ~30 s on a server that already has the images (the first project on a new server pulls
~7 GB of images once). The project page shows the API URL, keys, service health, usage, logs, auth settings, functions,
backups and **Open Studio**.

**CLI**:
```bash
levant base create my-backend                 # waits until ready and links this folder (.levant/base.json)
levant base create my-backend --project shop  # …owned by the Deploy project "shop" + SUPABASE_* env vars added to it
levant base ls
levant base status
```

Every project gets:

| | |
|---|---|
| API URL | `https://<ref>.<BASE_DOMAIN>` (`BASE_DOMAIN` defaults to `base.<your platform domain>`; wildcard DNS `*.base.example.com` → your server; TLS issued automatically). A custom API domain can be added in Settings. |
| Paths | `/auth/v1`, `/rest/v1`, `/graphql/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1` — exactly as upstream |
| `anon` key | public by design — ship it in browsers and apps; Row Level Security decides what it can do |
| `service_role` key | bypasses RLS — **servers only**. Team admins can reveal it (audited) |
| Studio | `https://studio-<ref>.<BASE_DOMAIN>`, opened from the dashboard with single sign-on (members and above) |

Roles: **Viewer** sees the project and the anon key · **Member** uses SQL, Studio, functions, backups list ·
**Admin** reveals the service key / DB password, changes auth & SMTP settings, secrets, backups/restore, deletes.

## 2. Connect a Deploy project

A Deploy project can own its backend (its **Backend** tab). *Connect* writes these env vars (choose the environments;
the service key only if you ask and are an admin):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public URL (browsers) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_URL` | production/preview: **internal** URL `http://base-<ref>:8000` (server-side code talks to the gateway over the private network — no TLS, no public round trip); development: the public URL |
| `SUPABASE_SERVICE_ROLE_KEY` | optional, secret |
| `DATABASE_URL` | optional, when the plan includes the connection pooler: `postgresql://postgres.<ref>:…@base-<ref>:6543/postgres` (transaction mode; session mode on `:5432`) — for Prisma / Drizzle / any Postgres driver |

Redeploy after connecting (the dashboard shows the banner). For local work: `levant base env pull` writes the URL and
anon key (also as `VITE_…` and `EXPO_PUBLIC_…`) into `.env.local`, merged with what is already there.

## 3. Use it from code

**JavaScript / TypeScript** (`npm i @supabase/supabase-js`):
```ts
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

await supabase.auth.signUp({ email, password });
const { data: todos } = await supabase.from("todos").select("id, title, project:projects(name)").order("id");
await supabase.storage.from("avatars").upload(`${user.id}/me.png`, file, { upsert: true });
supabase.channel("room1").on("postgres_changes", { event: "*", schema: "public", table: "messages" }, console.log).subscribe();
await supabase.functions.invoke("hello", { body: { name: "Levant" } });
```
Typed client: `levant base gen types typescript > src/database.types.ts`, then `createClient<Database>(…)`.
Server components (Next.js `@supabase/ssr`) work the same — use `SUPABASE_URL` (internal) on the server.

**Flutter** (`flutter pub add supabase_flutter`):
```dart
await Supabase.initialize(url: 'https://<ref>.base.example.com', anonKey: '<anon key>');
final supabase = Supabase.instance.client;
await supabase.auth.signInWithPassword(email: email, password: password);
final rows = await supabase.from('todos').select().eq('done', false);
```
Deep links for email confirmation / OAuth: add your scheme (`io.example.app://login-callback`) to **Auth → Redirect URLs**.

**curl**:
```bash
URL=https://<ref>.base.example.com; ANON=<anon key>
curl "$URL/rest/v1/todos?select=*&done=eq.false" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
TOKEN=$(curl -s "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"…"}' | jq -r .access_token)
curl "$URL/rest/v1/todos" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"from curl"}'
curl "$URL/graphql/v1" -H "apikey: $ANON" -H 'content-type: application/json' -d '{"query":"{ todosCollection { edges { node { title } } } }"}'
```

## 4. Auth, providers and SMTP

Dashboard → project → **Auth**:
- **Site URL** + **Redirect URLs** (allow-list for `redirectTo` / `emailRedirectTo`, wildcards allowed).
- **Email**: sign-up on/off, **confirm email** (needs SMTP), magic links / OTP codes, password recovery. Without SMTP,
  new users are confirmed automatically (otherwise nobody could sign up) — configure SMTP before turning confirmations on.
- **SMTP**: host, port, user, password (stored encrypted), sender address and name; *Send test mail*. Any provider
  works (Postmark, SES, Mailgun, your own server). GoTrue sends at most one mail per address per minute.
- **Email templates**: confirmation, invite, magic link (`{{ .Token }}` = 6-digit code, `{{ .ConfirmationURL }}`),
  recovery, email change — subjects and HTML bodies.
- **Anonymous sign-ins** (`signInAnonymously()`), **phone** (with an SMS provider in *Advanced*), **MFA/TOTP**,
  JWT expiry, and extra `GOTRUE_*` settings (rate limits, hooks) in *Advanced*.
- **OAuth providers**: Apple, Azure, Bitbucket, Discord, Facebook, Figma, GitHub, GitLab, Google, Kakao, Keycloak,
  LinkedIn (OIDC), Notion, Slack (OIDC), Spotify, Twitch, Twitter, WorkOS, Zoom. The callback URL to register at the
  provider is `https://<ref>.<BASE_DOMAIN>/auth/v1/callback`.

Service-role admin API works as usual: `supabase.auth.admin.createUser / listUsers / deleteUser / generateLink`.

## 5. Row Level Security cookbook

Tables in `public` are reachable through the API **only as far as RLS allows** — enable it on every table.

```sql
-- own rows only
alter table public.todos enable row level security;
create policy "read own"   on public.todos for select to authenticated using (user_id = (select auth.uid()));
create policy "insert own" on public.todos for insert to authenticated with check (user_id = (select auth.uid()));
create policy "update own" on public.todos for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own" on public.todos for delete to authenticated using (user_id = (select auth.uid()));
-- default owner column:  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade

-- public read, signed-in write
create policy "anyone reads" on public.posts for select to anon, authenticated using (true);

-- team membership
create policy "team reads" on public.docs for select to authenticated
  using (exists (select 1 from public.members m where m.team_id = docs.team_id and m.user_id = (select auth.uid())));

-- role in the JWT (app_metadata is only writable with the service key)
create policy "admins" on public.reports for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- profile row per new user
create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, name text);
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin insert into public.profiles (id, name) values (new.id, new.raw_user_meta_data ->> 'name'); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
```
Tips: wrap `auth.uid()` in `(select …)` (evaluated once per query), index the columns used in policies, test with
`levant base sql` + `set local role authenticated; set local request.jwt.claims = '{"sub":"…"}'` or with two real users.
RPC functions run with the caller's rights (`security invoker`) unless declared `security definer`.

## 6. Storage

Buckets are public (objects readable at `/storage/v1/object/public/<bucket>/<path>` without a key) or private (needs a
user JWT allowed by policies on `storage.objects`, or a **signed URL**). Per-bucket size limits and MIME allow-lists
are supported; the plan's max upload size is the upper bound.

```sql
-- users manage files in a folder named after their id:  <bucket>/<uid>/…
create policy "own folder" on storage.objects for all to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
```
```ts
await supabase.storage.createBucket("avatars", { public: true, fileSizeLimit: "5MB", allowedMimeTypes: ["image/*"] }); // service key
const { data } = await supabase.storage.from("documents").createSignedUrl(`${uid}/report.pdf`, 3600);
supabase.storage.from("avatars").getPublicUrl("a.png", { transform: { width: 200, height: 200, resize: "cover" } });
```
Image transformations (`/storage/v1/render/image/…`: width, height, resize, quality, format) are served by imgproxy
inside the project. Signed upload URLs (`createSignedUploadUrl` / `uploadToSignedUrl`) work; resumable (TUS)
uploads are served by the same upstream storage server (not covered by the compat suite yet).

## 7. Realtime

- **Postgres changes**: add the table to the publication, then subscribe; events respect RLS (a user only receives rows
  they may select). For `old` values on UPDATE/DELETE set `replica identity full`.
  ```sql
  alter publication supabase_realtime add table public.messages;
  alter table public.messages replica identity full;
  ```
  The server confirms a live subscription with a `system` message (`Subscribed to PostgreSQL`) shortly after `SUBSCRIBED`.
- **Broadcast** (client ↔ client, or from servers via REST `channel.httpSend`) and **Presence** (`track`, `sync`,
  `join`, `leave`) work without any database setup.

## 8. Edge Functions

Deno functions served at `https://<ref>.<BASE_DOMAIN>/functions/v1/<slug>`.
```ts
// supabase/functions/hello/index.ts
import { corsHeaders } from "../_shared/cors.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { name } = await req.json();
  return Response.json({ message: `Hello ${name}`, stripe: !!Deno.env.get("STRIPE_KEY") }, { headers: corsHeaders });
});
```
```bash
levant base functions deploy hello           # or without a slug: every folder in supabase/functions
levant base functions deploy stripe-webhook --no-verify-jwt
levant base secrets set STRIPE_KEY=sk_live_… # or --env-file supabase/.env ; names: levant base secrets ls
levant base functions invoke hello -d '{"name":"Levant"}'
```
- **JWT verification** is on by default (anon key or a user's JWT required). Turn it off per function for webhooks
  (`--no-verify-jwt`, the dashboard switch, or `[functions.<slug>] verify_jwt = false` in `supabase/config.toml`).
- Inside a function: `SUPABASE_URL` (internal gateway), `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_DB_URL`, your secrets. Imports: `npm:`, `jsr:` and `https:` specifiers (downloaded on first use — the
  server needs outbound internet for them). Sibling helpers in `supabase/functions/_shared/` are uploaded with the
  function; per-function `deno.json` import maps are not applied (use full specifiers).
- Limits: 2 MB source per function, 150 MB memory, 150 s idle timeout; number of functions and monthly invocations per plan.

## 9. Migrations and the CLI

Install: `npm i -g https://<your server>/api/cli/levant.tgz`, then `levant login --server https://<your server>`.
The CLI understands the folder layout of existing apps: `supabase/migrations/*.sql`, `supabase/functions/<slug>/`,
`supabase/config.toml`.

| Command | |
|---|---|
| `levant base ls` · `create <name> [--project [slug]]` · `link [ref]` · `status` | projects; `link` writes `.levant/base.json` (a folder linked to a Deploy project finds its backend automatically) |
| `levant base keys [--service]` | URL + anon key; `--service` adds the service_role key (admins, warns) |
| `levant base env pull [file]` | `.env.local` (merged) with `SUPABASE_URL`, `NEXT_PUBLIC_…`, `VITE_…`, `EXPO_PUBLIC_…` (+ `--service`) |
| `levant base db push [dir]` | applies new `*.sql` files in version order (default `supabase/migrations`); `--dry-run` |
| `levant base db dump [-f file]` | `pg_dump` (SQL) of auth, public, storage and your schemas (admins; also kept as a backup) |
| `levant base db url [--reveal]` | connection string (pooler; public port when enabled) |
| `levant base sql "<sql>"` · `-f file` · stdin | run SQL as `postgres`, print the result |
| `levant base functions deploy [slug] [--dir] [--no-verify-jwt]` · `ls` · `rm` · `invoke` | edge functions |
| `levant base secrets set KEY=val… [--env-file]` · `ls` · `unset` | function secrets (write-only) |
| `levant base gen types typescript [-s schema]` | database types (same generator as upstream) |
| `levant base studio` | open Studio |
| `--ref <ref|name>` | target another project; `--team <slug>` |

**How `db push` works**: files are sorted by their numeric prefix (`20240101120000_name.sql`). Applied versions are
recorded in `levant.levant_migrations` (version, name, checksum, applied_at, applied_by; not exposed through the API);
versions recorded by the Supabase CLI in `supabase_migrations.schema_migrations` (projects moved with `pg_dump`) count
as applied. Each file runs in one transaction together with its history row — a failing file is rolled back and stops
the push. Files using `CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`, `VACUUM` or their own `BEGIN/COMMIT` run
without the wrapping transaction; files larger than ~90 KB are sent in statement-sized parts (warned). An edited file
that was already applied is reported, not re-run — add a new migration instead. SQL runs as `postgres` (like the
hosted SQL editor), so objects belong to `postgres`.

CI example:
```bash
export LEVANT_SERVER=https://deploy.example.com LEVANT_TOKEN=$LEVANT_TOKEN
levant base db push --ref my-backend --yes && levant base functions deploy --ref my-backend
```

## 10. Backups

- **Scheduled** daily logical backups (`pg_dump` of `auth`, `public`, `storage`, `supabase_migrations` and every user
  schema), kept per plan (Hobby: none — manual only; Pro: 7; Team: 14).
- **Manual** backup any time (dashboard → Settings → Backups, or `levant base db dump`), **download** (`.sql.gz`,
  admins, audited) and **restore** (a safety backup is taken first; the project is briefly unavailable).
- Storage files are not part of the database backup (their `storage.objects` rows are); copy important buckets with
  the script in §12 if you need off-server copies.

## 11. Limits per plan

| | Hobby | Pro | Team |
|---|---|---|---|
| Active Base projects | 2 | unlimited | unlimited |
| Database size | 500 MB | 8 GB | 16 GB |
| File storage | 1 GB | 100 GB | 200 GB |
| Max upload | 50 MB | 5 GB | 5 GB |
| Monthly active users | 50,000 | 100,000 | 200,000 |
| Egress / month | 5 GB | 250 GB | 500 GB |
| Function invocations / month | 500,000 | 2,000,000 | 5,000,000 |
| Edge functions | 10 | 500 | 1,000 |
| Pause after inactivity | 7 days | never | never |
| Daily backups kept | 0 (manual only) | 7 | 14 |
| Connection pooler / public DB port | — | yes | yes |
| CPU / memory per project | 0.5 CPU / 1.5 GB | 2 CPU / 4 GB | 4 CPU / 8 GB |

Over a soft limit you get a warning at 80 % and an email at 100 %; then the database becomes read-only (writes return
`507`), uploads are blocked, or a Hobby project is paused — until usage is back under the limit or the plan changes.
The platform owner can edit plans and override limits per project.

## 12. Migrating an existing project

From a hosted or self-hosted project that uses the same open-source stack:

1. **Create** the backend: `levant base create my-app` (in the app's folder) and configure Auth (site URL, redirect
   URLs, SMTP, providers — callback URL `https://<ref>.<BASE_DOMAIN>/auth/v1/callback`).
2. **Schema + data** — with the Supabase CLI against the old project:
   ```bash
   supabase db dump --db-url "$OLD_DB_URL" -f supabase/migrations/20240000000000_schema.sql
   supabase db dump --db-url "$OLD_DB_URL" --data-only -f supabase/migrations/20240000000001_data.sql   # includes auth.users
   levant base db push
   ```
   (or `pg_dump --schema-only/--data-only` for the user schemas plus `auth`). On Pro/Team you can enable the public
   database port and use `psql`/`pg_restore` directly: `levant base db url --reveal`, `sslmode=require`.
   Users keep their passwords (bcrypt hashes are in `auth.users`); they sign in again because the JWT secret is new.
3. **Storage**: recreate the buckets and copy the objects:
   ```ts
   const from = createClient(OLD_URL, OLD_SERVICE_KEY), to = createClient(NEW_URL, NEW_SERVICE_KEY);
   for (const b of (await from.storage.listBuckets()).data!) {
     await to.storage.createBucket(b.id, { public: b.public, fileSizeLimit: b.file_size_limit ?? undefined, allowedMimeTypes: b.allowed_mime_types ?? undefined });
     const walk = async (prefix: string): Promise<void> => {
       for (const o of (await from.storage.from(b.id).list(prefix, { limit: 1000 })).data!) {
         const p = prefix ? `${prefix}/${o.name}` : o.name;
         if (!o.id) { await walk(p); continue; }                        // folder
         const file = (await from.storage.from(b.id).download(p)).data!;
         await to.storage.from(b.id).upload(p, file, { upsert: true, contentType: o.metadata?.mimetype });
       }
     };
     await walk("");
   }
   ```
   (If the data dump already contains `storage.objects` rows, upload with `upsert: true` as above.)
4. **Functions + secrets**: `levant base secrets set --env-file supabase/.env && levant base functions deploy`.
5. **Switch the app**: `levant base env pull` (or *Connect* in the Deploy project), update OAuth apps' callback URLs and
   mobile deep links, deploy.

## 13. Architecture and security model

```
browser / app ──HTTPS──► Caddy (LevantDeploy edge, on-demand TLS) ──► lb_<ref>_api-gw (Envoy, upstream config)
                                                                         ├─ /auth/v1      → auth (GoTrue)
                                                                         ├─ /rest/v1      → rest (PostgREST)
LevantDeploy apps ──http://base-<ref>:8000 (levant_net)──► same gateway   ├─ /graphql/v1   → rest → pg_graphql
                                                                         ├─ /realtime/v1  → realtime (websocket)
                                                                         ├─ /storage/v1   → storage (+ imgproxy)
                                                                         ├─ /functions/v1 → functions (edge-runtime)
                                                                         └─ /pg           → meta (service key only)
                                     lb_<ref>_net (internal) : db (Postgres) · pooler (optional) · studio (on demand)
```
- **One stack per project**, rendered from the vendored upstream compose file into `STORAGE_DIR/base/<ref>/` and run as
  compose project `lb_<ref>` with CPU/memory limits from the plan. Images are pinned; upgrades are per project.
- **Isolation**: every service sits on the project's `internal` network; only the gateway also joins `levant_net`
  (alias `base-<ref>`). The database, meta, auth, etc. are unreachable from other projects or apps. Only `auth` (SMTP,
  OAuth) and `functions` (outbound `fetch`) have outbound internet. No host ports, no Docker socket in any service.
- **Secrets per project**: database password, JWT secret (64 chars), anon/service keys (HS256, signed with that
  secret), realtime/vault/meta keys — all random, stored encrypted (AES-256-GCM) in the control database; rendered env
  files are `0600`. A key of one project is useless for another.
- **API gateway**: upstream key checks are kept — `/pg` requires the service key (anon → 403), REST/Auth/GraphQL need
  an apikey; the API host serves no Studio. Requests go through Caddy (TLS, upload size limit, quotas, access log for
  usage metering).
- **Studio** lives on its own host behind a forward-auth gate: the dashboard hands out a single-use 60 s token →
  host-only, HttpOnly, Secure cookie (12 h, re-checked against your team role every 30 s) → Envoy accepts Studio
  traffic only with a per-project gate secret that only Caddy adds.
- **Platform API**: every action uses LevantDeploy's users, teams, roles, API tokens (scopes `base:read` /
  `base:write`) and audit log (`base.sql`, `base.secret_reveal`, `base.backup.download`, …).
- **Pause / resume**: paused projects keep their volumes; the API answers 503 with a branded page until resumed.
