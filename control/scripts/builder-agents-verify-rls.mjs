// RLS verification with the real supabase-js against the app's LevantBase backend.
// env: SB_URL, SB_ANON, TABLE (default todos), TITLE_COL (default title)
import { createClient } from "@supabase/supabase-js";
const url = process.env.SB_URL, anon = process.env.SB_ANON, table = process.env.TABLE || "todos", col = process.env.TITLE_COL || "title";
const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`); };
const stamp = Date.now();
async function user(n) {
  const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `rls${n}.${stamp}@example.com`, password = "Passw0rd!x";
  const su = await c.auth.signUp({ email, password });
  if (su.error) throw new Error(`signUp ${n}: ${su.error.message}`);
  if (!su.data.session) {
    const si = await c.auth.signInWithPassword({ email, password });
    if (si.error) throw new Error(`signIn ${n}: ${si.error.message} (email confirmation required?)`);
  }
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id, email };
}
const a = await user("a"), b = await user("b");
const ia = await a.c.from(table).insert({ [col]: "A's todo" }).select().single();
ok("user A can insert own todo", !ia.error && ia.data?.user_id === a.id, ia.error?.message ?? "");
const ib = await b.c.from(table).insert({ [col]: "B's todo" }).select().single();
ok("user B can insert own todo", !ib.error && ib.data?.user_id === b.id, ib.error?.message ?? "");
const la = await a.c.from(table).select("*");
ok("user A sees only own rows", !la.error && la.data.length >= 1 && la.data.every((r) => r.user_id === a.id), `rows=${la.data?.length}`);
const lb = await b.c.from(table).select("*");
ok("user B sees only own rows", !lb.error && lb.data.length >= 1 && lb.data.every((r) => r.user_id === b.id), `rows=${lb.data?.length}`);
const spoof = await a.c.from(table).insert({ [col]: "spoof", user_id: b.id }).select();
ok("user A cannot insert a row owned by B", !!spoof.error, spoof.error?.code ?? "inserted!");
const upd = await a.c.from(table).update({ [col]: "hacked" }).eq("id", ib.data.id).select();
ok("user A cannot update B's row", !upd.error && upd.data.length === 0);
const del = await a.c.from(table).delete().eq("id", ib.data.id).select();
ok("user A cannot delete B's row", !del.error && del.data.length === 0);
const anonC = createClient(url, anon, { auth: { persistSession: false } });
const an = await anonC.from(table).select("*");
ok("anonymous sees nothing", (an.data ?? []).length === 0, an.error?.message ?? "");
const own = await a.c.from(table).update({ [col]: "A edited" }).eq("id", ia.data.id).select();
ok("user A can update own row", !own.error && own.data.length === 1);
const owndel = await a.c.from(table).delete().eq("id", ia.data.id).select();
ok("user A can delete own row", !owndel.error && owndel.data.length === 1);
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
