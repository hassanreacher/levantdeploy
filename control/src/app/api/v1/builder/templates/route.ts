import { route, json, requireApiTokenOrSession } from "@/lib/http";
import { STARTERS } from "@/lib/builder/projects";
import { TEMPLATES } from "@/lib/builder/template";

export const dynamic = "force-dynamic";

/** GET /api/v1/builder/templates → { items: [{ id, name, description, prompt, tags, kind, template }], templates } */
export const GET = route(async () => {
  await requireApiTokenOrSession({ scope: "projects:read" });
  return json({ items: STARTERS.map((s) => ({ ...s, kind: "template", template: "next15", thumbnail: null })), templates: TEMPLATES });
});
