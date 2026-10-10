import { route, json, requireApiTokenOrSession } from "@/lib/http";
import { listTemplates } from "@/lib/git/templates";

export const dynamic = "force-dynamic";

/** GET /api/v1/templates → { items: [{ id, name, description, framework, frameworkName }] } (the repo's examples/) */
export const GET = route(async () => {
  await requireApiTokenOrSession();
  return json({ items: listTemplates() });
});
