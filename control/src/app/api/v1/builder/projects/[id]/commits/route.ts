import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { log } from "@/lib/builder/git";
import { commitDTOs } from "@/lib/builder/dto";

export const dynamic = "force-dynamic";

/** GET …/commits?limit=&before=<sha>&path= → { items: Commit[], next } newest first (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().regex(/^[0-9a-f]{4,40}$/).optional(), path: z.string().max(300).optional() }));
  await requireBuilder(id, "VIEWER");
  const commits = await log(id, { limit: q.limit, before: q.before, path: q.path });
  return json({ items: await commitDTOs(id, commits), next: commits.length === q.limit ? commits[commits.length - 1]!.sha : null });
});
