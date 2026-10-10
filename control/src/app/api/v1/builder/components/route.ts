import { route, json, requireApiTokenOrSession } from "@/lib/http";
import { listLibrary } from "@/lib/builder/template";

export const dynamic = "force-dynamic";

/** GET /api/v1/builder/components → { items: [{ id, name, category, description, backend? }] } (visual editor "Add section") */
export const GET = route(async () => {
  await requireApiTokenOrSession({ scope: "projects:read" });
  return json({ items: listLibrary() });
});
