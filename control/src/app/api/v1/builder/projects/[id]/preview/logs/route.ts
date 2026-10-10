import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { getPreviewLogs } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

/** GET …/preview/logs?tail=300 → { lines: [{ ts, line }] } dev-server output (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ tail: z.coerce.number().int().min(1).max(2000).default(300) }));
  await requireBuilder(id, "VIEWER");
  return json({ lines: await getPreviewLogs(id, { tail: q.tail }) });
});
