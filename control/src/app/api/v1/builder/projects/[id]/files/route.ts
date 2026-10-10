import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { listFiles } from "@/lib/builder/files";

export const dynamic = "force-dynamic";

/** GET /api/v1/builder/projects/:id/files[?ref=<sha>] → { items: [{ path, size, tracked }] } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ ref: z.string().max(64).optional() }));
  await requireBuilder(id, "VIEWER");
  return json({ items: await listFiles(id, { ref: q.ref }) });
});

export { PUT, DELETE } from "./content/route";
