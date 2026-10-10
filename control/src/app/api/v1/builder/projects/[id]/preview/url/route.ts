import { z } from "zod";
import { json, query } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { issuePreviewToken, touchPreview } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

/** GET …/preview/url?next=/path → { url, expiresIn } one-time-ish (2 min) SSO URL for the iframe / "open in new tab". MEMBER. */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ next: z.string().max(500).default("/") }));
  const { user } = await requireBuilder(id, "MEMBER");
  await touchPreview(id, { ensureRunning: true });
  return json(await issuePreviewToken(id, user.id, q.next));
});
