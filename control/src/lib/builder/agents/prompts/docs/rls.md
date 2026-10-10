# Row Level Security patterns (Postgres / LevantBase)
```sql
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists notes_user_id_idx on public.notes(user_id);
alter table public.notes enable row level security;
grant select, insert, update, delete on public.notes to authenticated;
drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes for delete to authenticated using ((select auth.uid()) = user_id);
```
- Public catalog (anyone reads, nobody writes from the browser): `grant select on public.menu_items to anon, authenticated;`
  `create policy "menu_public_read" on public.menu_items for select to anon, authenticated using (true);`
- Public form submissions (contact form): `grant insert on public.messages to anon, authenticated;` + `for insert to anon, authenticated with check (true)` and NO select policy.
- Profiles: table `profiles (id uuid primary key references auth.users on delete cascade, …)` + trigger
  `create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$ begin insert into public.profiles (id) values (new.id); return new; end; $$;`
  `create or replace trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`
- Test as a role: `set local role authenticated; set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';`
- Never `disable row level security` on tables with user data.
