import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { diff, diffText, getCommit } from "@/lib/builder/git";
import { commitDTOs } from "@/lib/builder/dto";

export const dynamic = "force-dynamic";

/**
 * GET …/commits/:sha → { commit, files: FileChange[] (with patch) }   (VIEWER)
 * GET …/commits/:sha?format=patch → text/plain unified diff
 */
export const GET = builderRoute<{ id: string; sha: string }>(async (req, { params }) => {
  const { id, sha } = await params;
  const q = query(req, z.object({ format: z.enum(["json", "patch"]).default("json"), path: z.string().max(300).optional() }));
  await requireBuilder(id, "VIEWER");
  if (q.format === "patch") return new Response(await diffText(id, sha, { path: q.path }), { headers: { "content-type": "text/plain; charset=utf-8" } });
  const c = await getCommit(id, sha);
  const [dto] = await commitDTOs(id, [c]);
  const files = await diff(id, c.sha, { patches: true, path: q.path });
  return json({ commit: { ...dto, files }, files });
});
