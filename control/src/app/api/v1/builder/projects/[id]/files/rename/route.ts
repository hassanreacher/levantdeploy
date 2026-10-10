import { z } from "zod";
import { json, body } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { renameFile } from "@/lib/builder/files";
import { getCommit } from "@/lib/builder/git";
import { commitDTO } from "@/lib/builder/dto";

export const dynamic = "force-dynamic";

/** POST …/files/rename { from, to } → { commit } (MEMBER) */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ from: z.string().min(1).max(300), to: z.string().min(1).max(300) }));
  const { actor } = await requireBuilder(id, "MEMBER");
  const r = await renameFile(id, input.from, input.to, { commit: { message: `Rename ${input.from} → ${input.to}`, author: { name: actor.user.name, email: actor.user.email, userId: actor.user.id } } });
  return json({ from: r.from, to: r.to, commit: r.commit ? commitDTO(await getCommit(id, r.commit)) : null });
});
