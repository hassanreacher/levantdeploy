import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { diff } from "@/lib/builder/git";

export const dynamic = "force-dynamic";

/** GET …/diff?from=<sha>&to=<sha|HEAD>[&patches=0] → { files: FileChange[] } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ from: z.string().max(64), to: z.string().max(64).default("HEAD"), patches: z.enum(["0", "1"]).default("1"), path: z.string().max(300).optional() }));
  await requireBuilder(id, "VIEWER");
  return json({ files: await diff(id, q.to, { against: q.from, patches: q.patches === "1", path: q.path }) });
});
