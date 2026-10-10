import { z } from "zod";
import { route, query } from "@/lib/http";
import { serviceLogsResponse } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { LOG_SERVICES } from "@/lib/base-ui/shared";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/logs?service=auth[&tail=500&follow=0] — SSE in the LogViewer format (VIEWER). */
export const GET = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const q = query(
    req,
    z.object({
      service: z.enum(LOG_SERVICES as unknown as [string, ...string[]]),
      tail: z.coerce.number().int().min(1).max(5000).default(500),
      follow: z.enum(["0", "1"]).default("1"),
    }),
  );
  await requireBaseRole(ref, "VIEWER", { scope: "base:read" });
  return serviceLogsResponse(ref, q.service, { signal: req.signal, tail: q.tail, follow: q.follow === "1" });
});
