import { z } from "zod";
import { route, json, query, requirePlatformOwner } from "@/lib/http";
import { manifestFormTarget } from "@/lib/github/manifest";

export const dynamic = "force-dynamic";

const q = z.object({ org: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(), team: z.string().max(60).optional() });

/**
 * GET /api/v1/github/app/manifest?org=&team= → { action, manifest } for the "Create GitHub App" form:
 *   <form method="post" action={action}><input type="hidden" name="manifest" value={JSON.stringify(manifest)} /></form>
 */
export const GET = route(async (req) => {
  const { org, team } = query(req, q);
  const actor = await requirePlatformOwner();
  return json(await manifestFormTarget(actor.user.id, { org, teamSlug: team }));
});
