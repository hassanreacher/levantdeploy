import { z } from "zod";
import { json, body } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { getCommit, restore } from "@/lib/builder/git";
import { commitDTO } from "@/lib/builder/dto";

export const dynamic = "force-dynamic";

/** POST …/restore { sha } → { commit, changed } — new commit whose tree equals <sha> (history kept). MEMBER. */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ sha: z.string().regex(/^[0-9a-f]{4,40}$/), message: z.string().max(300).optional() }));
  const { actor, team } = await requireBuilder(id, "MEMBER");
  const r = await restore(id, input.sha, { name: actor.user.name, email: actor.user.email, userId: actor.user.id }, input.message);
  await audit({ action: "builder.restore", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { to: input.sha.slice(0, 12), commit: r.sha.slice(0, 12) } });
  return json({ commit: commitDTO(await getCommit(id, r.sha)), changed: r.changed });
});
