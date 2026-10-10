# supabase-js v2 cheat sheet (LevantBase is 100% Supabase API compatible)
Clients that exist in the template:
```ts
// client components ("use client")
import { getSupabase, requireSupabase } from "@/lib/supabase";   // getSupabase(): SupabaseClient | null (null = no backend)
const supabase = requireSupabase();                               // call inside effects/handlers
// server components / route handlers / server actions
import { createServerSupabase } from "@/lib/supabase-server";    // imports "server-only"
const supabase = await createServerSupabase();                    // SupabaseClient | null — cookie session (same user as the browser)
// typed (after base_types):
import type { Database } from "@/lib/database.types";
type Todo = Database["public"]["Tables"]["todos"]["Row"];
```
- Select: `const { data, error } = await supabase.from("todos").select("id, title, done").order("created_at", { ascending: false });`
- Filter: `.eq("done", false)`, `.ilike("title", "%x%")`, `.in("id", ids)`, `.range(0, 19)`, `.single()` / `.maybeSingle()`.
- Insert: `await supabase.from("todos").insert({ title }).select().single();` (user_id defaults to auth.uid() in the table).
- Update: `await supabase.from("todos").update({ done: true }).eq("id", id);`  Delete: `.delete().eq("id", id)`.
- Always: `if (error) { toast.error(error.message); return; }`. RLS-denied inserts return error code 42501; selects return [] silently.
- Realtime: `const ch = supabase.channel("todos").on("postgres_changes", { event: "*", schema: "public", table: "todos" }, (p) => …).subscribe(); return () => { supabase.removeChannel(ch); };`
  (table must be in the `supabase_realtime` publication: `alter publication supabase_realtime add table public.todos;`).
- Storage: `await supabase.storage.from("avatars").upload(`${user.id}/${file.name}`, file, { upsert: true });`
  public URL: `supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl`.
- Edge function: `await supabase.functions.invoke("hello", { body: { name } })`.
- Never use the service_role key in the browser; never prefix it with NEXT_PUBLIC_.
