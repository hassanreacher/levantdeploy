import { route, json } from "@/lib/http";
import { requireBaseRole } from "@/lib/base-ui/access";
import { usageFor } from "@/lib/base-ui/usage";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/usage — current month usage vs plan limits + daily series (VIEWER). */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base, team } = await requireBaseRole(ref, "VIEWER");
  return json(await usageFor(base, team.id));
});
