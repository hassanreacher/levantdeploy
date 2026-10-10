import { route, E } from "@/lib/http";
import { db } from "@/lib/db";
import { functionLogsResponse } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

export const dynamic = "force-dynamic";

/** GET — SSE log tail of one function (VIEWER). */
export const GET = route<{ ref: string; slug: string }>(async (req, { params }) => {
  const { ref, slug } = await params;
  const { base } = await requireBaseRole(ref, "VIEWER");
  if (!(await db.baseFunction.findUnique({ where: { baseProjectId_slug: { baseProjectId: base.id, slug } }, select: { id: true } }))) throw E.notFound("Function not found");
  return functionLogsResponse(ref, slug, { signal: req.signal });
});
