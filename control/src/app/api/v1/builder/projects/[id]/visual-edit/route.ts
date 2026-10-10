import { z } from "zod";
import { json, body, throttle } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { applyVisualEdits } from "@/lib/builder/visual-edit";
import { getCommit } from "@/lib/builder/git";
import { commitDTO } from "@/lib/builder/dto";
import { touchPreview } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

/**
 * POST …/visual-edit { ops: VisualEditOp[], message? } → { commit, results: [{ op, src, newSrc?, description }], files }
 * AST edits addressed by data-lv-src; one commit "visual edit: …" (author = user). The preview hot-reloads. MEMBER.
 */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ ops: z.array(z.record(z.unknown())).min(1).max(50), message: z.string().max(300).optional() }));
  const { user } = await requireBuilder(id, "MEMBER");
  await throttle(`builder-visual:${user.id}`, { limit: 240, window: 60 });
  const r = await applyVisualEdits(id, input.ops, { author: { name: user.name, email: user.email, userId: user.id }, message: input.message });
  void touchPreview(id);
  return json({ commit: r.commit ? commitDTO(await getCommit(id, r.commit)) : null, results: r.results, files: r.files });
});
