import { json, E, throttle } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { writeFile, MAX_BINARY_BYTES } from "@/lib/builder/files";
import { getCommit } from "@/lib/builder/git";
import { commitDTO } from "@/lib/builder/dto";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg", "image/x-icon": "ico" };

/**
 * POST …/uploads (multipart "file": image ≤ 5 MB) → { url: "/uploads/<name>", path: "public/uploads/<name>", commit }
 * Stores the image in the app's public/ folder (committed, published with the app) — use the URL in <img src>. MEMBER.
 */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const { user } = await requireBuilder(id, "MEMBER");
  await throttle(`builder-upload:${user.id}`, LIMITS.upload);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw E.bad('Send the image as multipart field "file"');
  const ext = TYPES[file.type];
  if (!ext) throw E.bad("Only PNG, JPEG, WebP, GIF, AVIF, SVG or ICO images");
  if (file.size > MAX_BINARY_BYTES) throw E.bad("Images must be 5 MB or smaller");
  const base =
    (file.name || "image")
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
  const name = `${base}-${Date.now().toString(36)}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === "svg" && /<script|on\w+\s*=|javascript:/i.test(Buffer.from(bytes).toString("utf8"))) throw E.bad("SVG files with scripts are not allowed");
  const r = await writeFile(id, `public/uploads/${name}`, bytes, { commit: { message: `Upload ${name}`, author: { name: user.name, email: user.email, userId: user.id } } });
  return json({ url: `/uploads/${name}`, path: r.path, size: r.size, commit: r.commit ? commitDTO(await getCommit(id, r.commit)) : null }, 201);
});
