import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { searchFiles } from "@/lib/builder/files";

export const dynamic = "force-dynamic";

/** GET …/files/search?q= → { items: [{ path, line, text }] } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ q: z.string().max(200).default("") }));
  await requireBuilder(id, "VIEWER");
  return json({ items: await searchFiles(id, q.q) });
});
