#!/usr/bin/env bash
# LevantBase end-to-end check through Caddy (HTTPS, local CA, on-demand certs) against a provisioned project.
# Usage (from control/, area env loaded, Caddy + control + worker running):  tests/base/e2e.sh <ref>
# Exits non-zero on the first failed check. Every check prints "ok <name>" / "FAIL <name>".
set -uo pipefail
REF="$1"
DOMAIN="${BASE_DOMAIN:-base.${PLATFORM_DOMAIN:-levant.localhost}}"
H="$REF.$DOMAIN"
SH="studio-$REF.$DOMAIN"
C=(curl -sk --resolve "$H:443:127.0.0.1" --resolve "$SH:443:127.0.0.1" --max-time 60)
LB=(npx tsx tests/base/lb.ts)
K=$("${LB[@]}" keys "$REF")
ANON=$(jq -r .anonKey <<<"$K")
SVC=$(jq -r .serviceRoleKey <<<"$K")
FAILS=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1 ${2:-}"; FAILS=$((FAILS + 1)); }
expect() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(expected $2, got $3)"; fi
}
code() { "${C[@]}" -o /dev/null -w "%{http_code}" "$@"; }

echo "── auth ──"
EMAIL="e2e-$(date +%s)@example.com"
expect "auth signup" 200 "$(code "https://$H/auth/v1/signup" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"Sup3r-secret-pw\"}")"
TOK=$("${C[@]}" "https://$H/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"Sup3r-secret-pw\"}")
JWT=$(jq -r .access_token <<<"$TOK")
UID_=$(jq -r .user.id <<<"$TOK")
[ "${#JWT}" -gt 100 ] && ok "auth login (password grant → access token)" || bad "auth login" "$TOK"
expect "auth wrong password → 400" 400 "$(code "https://$H/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"nope\"}")"
expect "auth without apikey → 401" 401 "$(code "https://$H/auth/v1/user" -H "Authorization: Bearer $JWT")"
expect "auth /user with user JWT" 200 "$(code "https://$H/auth/v1/user" -H "apikey: $ANON" -H "Authorization: Bearer $JWT")"

echo "── rest + RLS ──"
"${LB[@]}" sql "$REF" postgres "create table if not exists public.todos (id bigint generated always as identity primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade, title text not null, created_at timestamptz default now());
alter table public.todos enable row level security;
drop policy if exists own_todos on public.todos;
create policy own_todos on public.todos for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.todos to authenticated;
notify pgrst, 'reload schema';" >/dev/null && ok "runSql DDL (table + RLS policy)" || bad "runSql DDL"
sleep 1
expect "rest insert as user" 201 "$(code "https://$H/rest/v1/todos" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d '{"title":"from e2e"}')"
N=$("${C[@]}" "https://$H/rest/v1/todos?select=title,user_id" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" | jq 'length')
[ "$N" -ge 1 ] && ok "rest select as user sees own rows ($N)" || bad "rest select as user" "$N"
expect "rest select as anon sees 0 rows (RLS)" 0 "$("${C[@]}" "https://$H/rest/v1/todos?select=title" -H "apikey: $ANON" | jq 'length')"
A=$(code "https://$H/rest/v1/todos" -H "apikey: $ANON" -H 'content-type: application/json' -d '{"title":"anon"}')
[ "$A" = 401 ] || [ "$A" = 403 ] && ok "rest insert as anon refused ($A)" || bad "rest insert as anon" "$A"
expect "rest without apikey → 401" 401 "$(code "https://$H/rest/v1/todos")"
R=$("${LB[@]}" sql "$REF" anon "select count(*) as n from public.todos" | jq -r '.rows[0].n')
expect "runSql as anon respects RLS" 0 "$R"

echo "── storage ──"
BUCKET="e2e$(date +%s)"
expect "storage create bucket (service key)" 200 "$(code "https://$H/storage/v1/bucket" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H 'content-type: application/json' -d "{\"name\":\"$BUCKET\",\"public\":false}")"
head -c 300000 /dev/urandom > /tmp/lb-e2e-upload.bin
expect "storage upload" 200 "$(code "https://$H/storage/v1/object/$BUCKET/dir/file.bin" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H 'content-type: application/octet-stream' --data-binary @/tmp/lb-e2e-upload.bin)"
"${C[@]}" "https://$H/storage/v1/object/$BUCKET/dir/file.bin" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -o /tmp/lb-e2e-download.bin
cmp -s /tmp/lb-e2e-upload.bin /tmp/lb-e2e-download.bin && ok "storage download (identical bytes)" || bad "storage download"
S=$(code "https://$H/storage/v1/object/$BUCKET/dir/file.bin" -H "apikey: $ANON")
[ "$S" = 400 ] || [ "$S" = 403 ] || [ "$S" = 404 ] && ok "storage private object refused for anon ($S)" || bad "storage anon" "$S"

echo "── realtime ──"
WS=$("${C[@]}" --http1.1 -i -N --max-time 4 "https://$H/realtime/v1/websocket?apikey=$ANON&vsn=1.0.0" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" 2>/dev/null | head -1 | tr -d '\r')
[[ "$WS" == *101* ]] && ok "realtime websocket handshake ($WS)" || bad "realtime websocket" "$WS"

echo "── edge functions ──"
cat > /tmp/lb-e2e-fn.ts <<'TS'
Deno.serve(async (req) => {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  return Response.json({ hello: body.name ?? "world", slug: Deno.env.get("SUPABASE_FUNCTION_SLUG"), runtime: "levantbase" });
});
TS
T0=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
"${LB[@]}" fn "$REF" hello-levant /tmp/lb-e2e-fn.ts >/dev/null && ok "function deploy" || bad "function deploy"
W=$("${LB[@]}" job-wait "$REF" functions "$T0")
[[ "$W" == success* ]] && ok "functions reload job ($W)" || bad "functions reload job" "$W"
for i in $(seq 1 60); do
  OUT=$("${C[@]}" "https://$H/functions/v1/hello-levant" -H "Authorization: Bearer $ANON" -H 'content-type: application/json' -d '{"name":"levant"}')
  [ "$(jq -r .hello <<<"$OUT" 2>/dev/null)" = levant ] && break
  sleep 2
done
expect "function invoke" levant "$(jq -r .hello <<<"$OUT" 2>/dev/null)"
expect "function without JWT → 401 (verify_jwt)" 401 "$(code "https://$H/functions/v1/hello-levant")"

echo "── /pg (postgres-meta) ──"
expect "/pg with anon key → 403" 403 "$(code "https://$H/pg/tables" -H "apikey: $ANON" -H "Authorization: Bearer $ANON")"
P=$(code "https://$H/pg/tables" -H "apikey: ''")
[ "$P" = 401 ] || [ "$P" = 403 ] && ok "/pg with empty/invalid key refused ($P)" || bad "/pg empty key" "$P"
expect "/pg with service key → 200" 200 "$(code "https://$H/pg/tables" -H "apikey: $SVC" -H "Authorization: Bearer $SVC")"
R=$(code "https://$H/"); [ "$R" = 401 ] || [ "$R" = 404 ] && ok "API host has no Studio (/ → $R, unmatched path)" || bad "API host /" "$R"

echo "── studio SSO ──"
expect "studio without cookie → 401 page" 401 "$(code "https://$SH/project/default")"
expect "studio forged gate header still → 401" 401 "$(code "https://$SH/project/default" -H "X-Levant-Studio-Gate: x")"
expect "studio forged cookie → 401" 401 "$(code "https://$SH/project/default" -b "__levant_studio=u.$REF.9999999999.deadbeef")"
URL=$("${LB[@]}" studio-token "$REF")
JAR=/tmp/lb-e2e-cookies.txt; rm -f "$JAR"
SSO=$("${C[@]}" -c "$JAR" -o /dev/null -w "%{http_code} %{redirect_url}" "$URL")
[[ "$SSO" == 303* ]] && ok "studio SSO hand-off → 303 + cookie" || bad "studio SSO" "$SSO"
grep -q "#HttpOnly_$SH" "$JAR" && ok "studio cookie is host-only + HttpOnly" || bad "studio cookie flags" "$(cat "$JAR")"
grep -q "TRUE" <(awk '$6=="__levant_studio"{print $4}' "$JAR") && ok "studio cookie Secure" || bad "studio cookie Secure"
expect "SSO token is single-use" 403 "$(code "$URL")"
for i in $(seq 1 90); do
  S=$(code -b "$JAR" "https://$SH/project/default")
  [ "$S" = 200 ] && break
  sleep 2
done
expect "studio loads with cookie" 200 "$S"
"${C[@]}" -b "$JAR" "https://$SH/project/default" | grep -qi "<html" && ok "studio returns HTML" || bad "studio HTML"
expect "studio API (pg-meta via studio) with cookie" 200 "$(code -b "$JAR" "https://$SH/api/platform/profile")"

echo "── connection pooler (Supavisor via the gateway alias on levant_net) ──"
CONN=$("${LB[@]}" conn "$REF")
PW=$(jq -r .password <<<"$CONN")
if [ "$(jq -r '.pooler != null' <<<"$CONN")" = true ]; then
  PQ=(docker run --rm --network "${DOCKER_NETWORK:-levant_net}" -e PGPASSWORD="$PW" -e PGSSLMODE="${POOLER_SSLMODE:-prefer}" postgres:16-alpine psql -X -At -h "base-$REF" -U "postgres.$REF" -d postgres)
  expect "pooler transaction mode (base-<ref>:6543) from a levant_net container" 1 "$("${PQ[@]}" -p 6543 -c 'select 1' 2>&1 | tail -1)"
  expect "pooler session mode (base-<ref>:5432) sees the RLS table" t "$("${PQ[@]}" -p 5432 -c "select to_regclass('public.todos') is not null" 2>&1 | tail -1)"
  R=$(docker run --rm --network "${DOCKER_NETWORK:-levant_net}" -e PGPASSWORD=wrong postgres:16-alpine psql -X -At -h "base-$REF" -p 6543 -U "postgres.$REF" -d postgres -c 'select 1' 2>&1 | tail -1)
  [[ "$R" == *"password"* || "$R" == *"auth"* || "$R" == *"FATAL"* ]] && ok "pooler rejects a wrong password" || bad "pooler wrong password" "$R"
else
  echo "skip pooler (not in this plan)"
fi

if [ "${SKIP_PUBLIC:-}" != 1 ]; then
  echo "── public database port (TLS required) ──"
  T0=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  PUB=$("${LB[@]}" public "$REF" on)
  PORT=$(jq -r .port <<<"$PUB")
  W=$("${LB[@]}" job-wait "$REF" settings "$T0")
  [[ "$W" == success* ]] && ok "public port enabled ($PORT): $W" || bad "public port job" "$W"
  for i in $(seq 1 30); do
    S1=$(PGPASSWORD="$PW" psql -X -At "host=127.0.0.1 port=$PORT user=postgres.$REF dbname=postgres sslmode=require connect_timeout=5" -c 'select ssl from pg_stat_ssl where pid = pg_backend_pid()' 2>&1 | tail -1)
    [ -n "$S1" ] && [[ "$S1" != *"could not connect"* && "$S1" != *"closed the connection"* && "$S1" != *"Connection refused"* ]] && break
    sleep 2
  done
  # the pooler terminates TLS; its upstream connection to postgres is internal (pg_stat_ssl shows the pooler→db hop)
  [[ "$S1" == t || "$S1" == f ]] && ok "public port: psql with sslmode=require connects (TLS to the pooler)" || bad "public sslmode=require" "$S1"
  S2=$(PGPASSWORD="$PW" psql -X -At "host=127.0.0.1 port=$PORT user=postgres.$REF dbname=postgres sslmode=disable connect_timeout=5" -c 'select 1' 2>&1 | tail -1)
  [[ "$S2" != 1 ]] && ok "public port: plaintext refused ($S2)" || bad "public plaintext accepted"
  S3=$(echo | openssl s_client -connect "127.0.0.1:$PORT" -starttls postgres 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)
  [[ "$S3" == *"$H"* ]] && ok "public port: per-project certificate ($S3)" || bad "public cert" "$S3"
  expect "connection string shows host:port" "$H:$PORT" "$("${LB[@]}" conn "$REF" | jq -r '"\(.publicHost):\(.publicPort)"')"
  T0=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  "${LB[@]}" public "$REF" off >/dev/null
  W=$("${LB[@]}" job-wait "$REF" settings "$T0")
  S4=$(PGPASSWORD="$PW" psql -X -At "host=127.0.0.1 port=$PORT user=postgres.$REF dbname=postgres sslmode=require connect_timeout=3" -c 'select 1' 2>&1 | tail -1)
  [[ "$S4" != 1 ]] && ok "public port disabled → closed" || bad "public port still open"
fi

if [ "${SKIP_LIFECYCLE:-}" != 1 ]; then
  echo "── pause / resume ──"
  "${LB[@]}" action "$REF" pause >/dev/null && "${LB[@]}" wait "$REF" PAUSED 180 >/dev/null && ok "pause" || bad "pause"
  sleep 1
  PB=$("${C[@]}" -w "\n%{http_code}" "https://$H/rest/v1/todos" -H "apikey: $ANON")
  expect "paused → 503" 503 "$(tail -1 <<<"$PB")"
  grep -q "Project paused — restore it from the dashboard" <<<"$PB" && ok "paused branded page" || bad "paused page"
  "${LB[@]}" action "$REF" resume >/dev/null && "${LB[@]}" wait "$REF" ACTIVE 600 >/dev/null && ok "resume" || bad "resume"
  for i in $(seq 1 15); do
    N2=$("${C[@]}" "https://$H/rest/v1/todos?select=title" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" | jq 'length' 2>/dev/null)
    [ "$N2" = "$N" ] && break
    sleep 1
  done
  expect "data still there after resume" "$N" "$N2"
  "${C[@]}" "https://$H/storage/v1/object/$BUCKET/dir/file.bin" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -o /tmp/lb-e2e-download2.bin
  cmp -s /tmp/lb-e2e-upload.bin /tmp/lb-e2e-download2.bin && ok "storage object still there after resume" || bad "storage after resume"

  echo "── backup / restore ──"
  J=$("${LB[@]}" action "$REF" backup)
  BID=$(jq -r .backupId <<<"$J")
  for i in $(seq 1 120); do
    ST=$("${LB[@]}" backups "$REF" | jq -r ".[] | select(.id==\"$BID\") | .status")
    [ -n "$ST" ] && [ "$ST" != RUNNING ] && break
    sleep 1
  done
  expect "backup" SUCCEEDED "$ST"
  code "https://$H/rest/v1/todos" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d '{"title":"after backup"}' >/dev/null
  expect "upload after backup" 200 "$(code "https://$H/storage/v1/object/$BUCKET/after-backup.bin" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" --data-binary @/tmp/lb-e2e-upload.bin)"
  expect "backup includes a storage archive" true "$("${LB[@]}" backups "$REF" | jq -r ".[] | select(.id==\"$BID\") | (.storagePath != null)")"
  expect "row added after backup" $((N + 1)) "$("${C[@]}" "https://$H/rest/v1/todos?select=title" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" | jq 'length')"
  "${LB[@]}" action "$REF" restore "{\"backupId\":\"$BID\"}" >/dev/null && sleep 2 && "${LB[@]}" wait "$REF" ACTIVE 600 >/dev/null && ok "restore" || bad "restore"
  for i in $(seq 1 30); do
    N3=$("${C[@]}" "https://$H/rest/v1/todos?select=title" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" | jq 'length' 2>/dev/null)
    [ "$N3" = "$N" ] && break
    sleep 2
  done
  expect "restored to the backup state (row added after the backup is gone)" "$N" "$N3"
  G=$(code "https://$H/storage/v1/object/$BUCKET/after-backup.bin" -H "apikey: $SVC" -H "Authorization: Bearer $SVC")
  [ "$G" = 400 ] || [ "$G" = 404 ] && ok "restored storage: file uploaded after the backup is gone ($G)" || bad "restored storage newer file" "$G"
  "${C[@]}" "https://$H/storage/v1/object/$BUCKET/dir/file.bin" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -o /tmp/lb-e2e-download3.bin
  cmp -s /tmp/lb-e2e-upload.bin /tmp/lb-e2e-download3.bin && ok "restored storage: original file intact" || bad "restored storage original"
  expect "auth still works after restore (same user)" 200 "$(code "https://$H/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"Sup3r-secret-pw\"}")"
fi

echo
[ "$FAILS" = 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS CHECK(S) FAILED"
exit "$FAILS"
