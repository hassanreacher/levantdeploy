# Auth with supabase-js (email + password, cookie sessions via @supabase/ssr)
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { requireSupabase } from "@/lib/supabase";

const supabase = requireSupabase();
// sign up
const { data, error } = await supabase.auth.signUp({ email, password });
if (error) toast.error(error.message); else if (!data.session) setInfo("Check your email to confirm your account.");
// sign in
const { error } = await supabase.auth.signInWithPassword({ email, password });
if (!error) { router.push("/todos"); router.refresh(); }
// sign out
await supabase.auth.signOut(); router.push("/login"); router.refresh();
// current user (client)
const { data: { user } } = await supabase.auth.getUser();
// react to changes
useEffect(() => { const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null)); return () => sub.subscription.unsubscribe(); }, [supabase]);
```
Protected server page (session is in cookies, so the server knows the user):
```tsx
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";
export default async function TodosPage() {
  const supabase = await createServerSupabase();
  if (!supabase) return <p>Backend not connected.</p>;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: todos } = await supabase.from("todos").select("*").order("created_at");
  return <TodoList initialTodos={todos ?? []} userEmail={user.email ?? ""} />;   // TodoList = client component for mutations
}
```
- Password min length is 6 by default; show `error.message` to the user.
- After client-side mutations call `router.refresh()` to re-render server components, or keep local state.
- Header: show "Sign in" link or the user's email + sign-out button.
