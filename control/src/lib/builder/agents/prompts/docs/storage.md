# Storage buckets & policies
- Create: tool `base_create_bucket` { name: "avatars", public: true }.
- Upload policy (users write to their own folder `<uid>/file`):
```sql
drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "avatars_read" on storage.objects;
create policy "avatars_read" on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');
```
- Client: `supabase.storage.from("avatars").upload(`${user.id}/${Date.now()}-${file.name}`, file)`; display with `getPublicUrl` (public bucket)
  or `createSignedUrl(path, 3600)` (private bucket). Render user images with `<img>` (remote host).
