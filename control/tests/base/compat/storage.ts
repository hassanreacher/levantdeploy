import { assert, check, eq, imageSize, lbFetch, ok, png, sql, uniq } from "./lib";
import type { Ctx } from "./auth";

export async function storageSuite(ctx: Ctx) {
  const S = "storage";
  const { a, b } = ctx.users;
  const pub = uniq("pub-");
  const priv = uniq("priv-");
  const text = Buffer.from(`hello from the compat suite ${new Date().toISOString()}\n`);

  await check(S, "createBucket (public) with service_role", async () => {
    ok(await ctx.admin.storage.createBucket(pub, { public: true, allowedMimeTypes: ["image/*", "text/plain"], fileSizeLimit: "5MB" }), "createBucket");
  });
  await check(S, "createBucket (private) + getBucket + listBuckets", async () => {
    ok(await ctx.admin.storage.createBucket(priv, { public: false }), "createBucket");
    eq(ok(await ctx.admin.storage.getBucket(priv), "getBucket").public, false, "public");
    const all = ok(await ctx.admin.storage.listBuckets(), "listBuckets");
    assert(all.some((x) => x.id === pub) && all.some((x) => x.id === priv), "buckets missing");
  });
  await check(S, "createBucket refused for anon", async () => {
    const r = await ctx.anon.storage.createBucket(uniq("nope-"));
    assert(r.error, "anon could create a bucket");
  });

  await check(S, "storage RLS policies created via SQL (per-user folder in the private bucket)", async () => {
    await sql(
      ctx.ref,
      `create policy "compat own folder read ${priv}" on storage.objects for select to authenticated using (bucket_id = '${priv}' and (storage.foldername(name))[1] = (select auth.uid())::text);
       create policy "compat own folder write ${priv}" on storage.objects for insert to authenticated with check (bucket_id = '${priv}' and (storage.foldername(name))[1] = (select auth.uid())::text);
       create policy "compat own folder update ${priv}" on storage.objects for update to authenticated using (bucket_id = '${priv}' and (storage.foldername(name))[1] = (select auth.uid())::text);
       create policy "compat own folder delete ${priv}" on storage.objects for delete to authenticated using (bucket_id = '${priv}' and (storage.foldername(name))[1] = (select auth.uid())::text);`,
    );
  });

  const own = `${a.id}/notes/hello.txt`;
  await check(S, "upload as a user into the own folder", async () => {
    const r = ok(await a.sb.storage.from(priv).upload(own, text, { contentType: "text/plain", upsert: false }), "upload");
    eq(r.path, own, "path");
  });
  await check(S, "download returns identical bytes", async () => {
    const blob = ok(await a.sb.storage.from(priv).download(own), "download");
    assert(Buffer.from(await blob.arrayBuffer()).equals(text), "bytes differ");
  });
  await check(S, "list folder", async () => {
    const r = ok(await a.sb.storage.from(priv).list(`${a.id}/notes`), "list");
    eq(r.map((x) => x.name), ["hello.txt"], "names");
  });
  await check(S, "upload with upsert replaces the object", async () => {
    ok(await a.sb.storage.from(priv).upload(own, Buffer.from("v2"), { contentType: "text/plain", upsert: true }), "upsert");
    eq(await (ok(await a.sb.storage.from(priv).download(own), "download") as Blob).text(), "v2", "content");
  });
  await check(S, "copy + move", async () => {
    ok(await a.sb.storage.from(priv).copy(own, `${a.id}/notes/copy.txt`), "copy");
    ok(await a.sb.storage.from(priv).move(`${a.id}/notes/copy.txt`, `${a.id}/archive/moved.txt`), "move");
    eq(ok(await a.sb.storage.from(priv).list(`${a.id}/archive`), "list").map((x) => x.name), ["moved.txt"], "moved");
    eq(ok(await a.sb.storage.from(priv).list(`${a.id}/notes`), "list").map((x) => x.name), ["hello.txt"], "source kept by copy, copy moved");
  });
  await check(S, "storage RLS: another user cannot read, list or overwrite", async () => {
    const d = await b.sb.storage.from(priv).download(own);
    assert(d.error, "user B could download");
    eq(ok(await b.sb.storage.from(priv).list(`${a.id}/notes`), "list").length, 0, "B list");
    const u = await b.sb.storage.from(priv).upload(`${a.id}/notes/evil.txt`, Buffer.from("x"), { contentType: "text/plain" });
    assert(u.error, "user B could upload into A's folder");
    return `upload → ${(u.error as { statusCode?: string }).statusCode ?? u.error.message}`;
  });
  await check(S, "private bucket refused for anon", async () => {
    const r = await ctx.anon.storage.from(priv).download(own);
    assert(r.error, "anon could download");
  });
  await check(S, "createSignedUrl + fetch (no auth header)", async () => {
    const r = ok(await a.sb.storage.from(priv).createSignedUrl(own, 60), "createSignedUrl");
    assert(r.signedUrl.startsWith(ctx.url + "/storage/v1/object/sign/"), `signedUrl ${r.signedUrl}`);
    const res = await lbFetch(r.signedUrl);
    eq(res.status, 200, "status");
    eq(await res.text(), "v2", "body");
    const bad = await lbFetch(r.signedUrl.replace(/token=[^&]+/, "token=forged"));
    assert(bad.status >= 400, `forged token status ${bad.status}`);
  });
  await check(S, "createSignedUploadUrl + uploadToSignedUrl", async () => {
    const path = `${a.id}/signed/up.txt`;
    const r = ok(await a.sb.storage.from(priv).createSignedUploadUrl(path), "createSignedUploadUrl");
    ok(await ctx.anon.storage.from(priv).uploadToSignedUrl(path, r.token, Buffer.from("signed upload"), { contentType: "text/plain" }), "uploadToSignedUrl");
    eq(await (ok(await a.sb.storage.from(priv).download(path), "download") as Blob).text(), "signed upload", "content");
  });

  const image = await png(120, 80);
  const imgPath = `img/${uniq("pic")}.png`;
  await check(S, "upload to the public bucket (service_role)", async () => {
    ok(await ctx.admin.storage.from(pub).upload(imgPath, image, { contentType: "image/png", cacheControl: "60" }), "upload");
  });
  await check(S, "public URL fetch (no key)", async () => {
    const u = ctx.anon.storage.from(pub).getPublicUrl(imgPath).data.publicUrl;
    assert(u === `${ctx.url}/storage/v1/object/public/${pub}/${imgPath}`, `publicUrl ${u}`);
    const res = await lbFetch(u);
    eq(res.status, 200, "status");
    eq(res.headers.get("content-type"), "image/png", "content-type");
    assert(Buffer.from(await res.arrayBuffer()).equals(image), "bytes differ");
  });
  await check(S, "bucket mime-type restriction enforced", async () => {
    const r = await ctx.admin.storage.from(pub).upload(`x/${uniq("f")}.json`, Buffer.from("{}"), { contentType: "application/json" });
    assert(r.error, "application/json accepted by an image/text bucket");
  });
  await check(S, "image transformation via imgproxy (/render/image, resize 60x40)", async () => {
    const u = ctx.anon.storage.from(pub).getPublicUrl(imgPath, { transform: { width: 60, height: 40, resize: "cover" } }).data.publicUrl;
    assert(u.includes("/storage/v1/render/image/public/"), `url ${u}`);
    const res = await lbFetch(u);
    eq(res.status, 200, `status (${u})`);
    const size = imageSize(Buffer.from(await res.arrayBuffer()));
    assert(size, `not an image (${res.headers.get("content-type")})`);
    eq([size.width, size.height], [60, 40], `dimensions (${size.type})`);
    return `${size.type} ${size.width}x${size.height}`;
  });
  await check(S, "image transformation on a signed URL (private object)", async () => {
    const p = `${a.id}/img/pic.png`;
    ok(await a.sb.storage.from(priv).upload(p, image, { contentType: "image/png" }), "upload");
    const r = ok(await a.sb.storage.from(priv).createSignedUrl(p, 60, { transform: { width: 30, height: 20 } }), "sign");
    const res = await lbFetch(r.signedUrl);
    eq(res.status, 200, "status");
    const size = imageSize(Buffer.from(await res.arrayBuffer()));
    assert(size && size.width === 30 && size.height === 20, `size ${JSON.stringify(size)}`);
  });

  await check(S, "remove objects", async () => {
    const r = ok(await a.sb.storage.from(priv).remove([own, `${a.id}/archive/moved.txt`, `${a.id}/signed/up.txt`, `${a.id}/img/pic.png`]), "remove");
    eq(r.length, 4, "removed");
    eq(ok(await a.sb.storage.from(priv).list(`${a.id}/notes`), "list").length, 0, "left");
  });
  await check(S, "emptyBucket + deleteBucket", async () => {
    ok(await ctx.admin.storage.emptyBucket(pub), "emptyBucket");
    ok(await ctx.admin.storage.deleteBucket(pub), "deleteBucket");
    ok(await ctx.admin.storage.emptyBucket(priv), "emptyBucket");
    ok(await ctx.admin.storage.deleteBucket(priv), "deleteBucket");
  });
  await sql(ctx.ref, `do $$ declare p record; begin for p in select policyname from pg_policies where schemaname = 'storage' and policyname like 'compat own folder %${priv}' loop execute format('drop policy %I on storage.objects', p.policyname); end loop; end $$;`).catch(() => {});
}
