import { z } from "zod";
import { json, body, query, throttle } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { deleteFile, readFile, writeFile } from "@/lib/builder/files";
import { getCommit } from "@/lib/builder/git";
import { commitDTO } from "@/lib/builder/dto";

export const dynamic = "force-dynamic";

/** GET …/files/content?path=&ref= → { path, size, binary, encoding, content, truncated? } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ path: z.string().min(1).max(300), ref: z.string().max(64).optional() }));
  await requireBuilder(id, "VIEWER");
  return json(await readFile(id, q.path, { ref: q.ref }));
});

const schema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(8 * 1024 * 1024),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  message: z.string().trim().max(500).optional(),
});

/** PUT …/files/content { path, content, encoding?, message? } → { file, commit } — saves + commits (author = user). MEMBER. */
export const PUT = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const { actor, team } = await requireBuilder(id, "MEMBER");
  await throttle(`builder-write:${actor.user.id}`);
  const r = await writeFile(id, input.path, input.content, {
    encoding: input.encoding,
    commit: { message: input.message || `Edit ${input.path}`, author: { name: actor.user.name, email: actor.user.email, userId: actor.user.id } },
  });
  await audit({ action: "builder.file_write", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { path: r.path, size: r.size } });
  return json({ file: { path: r.path, size: r.size }, commit: r.commit ? commitDTO(await getCommit(id, r.commit)) : null });
});

/** DELETE …/files/content?path= → { commit } (MEMBER) */
export const DELETE = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ path: z.string().min(1).max(300) }));
  const { actor, team } = await requireBuilder(id, "MEMBER");
  const r = await deleteFile(id, q.path, { commit: { message: `Delete ${q.path}`, author: { name: actor.user.name, email: actor.user.email, userId: actor.user.id } } });
  await audit({ action: "builder.file_delete", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { path: r.path } });
  return json({ commit: r.commit ? commitDTO(await getCommit(id, r.commit)) : null });
});
