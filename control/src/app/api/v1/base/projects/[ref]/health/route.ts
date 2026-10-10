import { route, json } from "@/lib/http";
import { serviceHealth } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/health → { status, services: [{ service, state }] } — VIEWER. */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base } = await requireBaseRole(ref, "VIEWER");
  const services = await serviceHealth(ref).catch(() => []);
  return json({ status: base.status, services });
});
