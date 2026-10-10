import { z } from "zod";
import { route, json, body, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { listFunctionSecrets, setFunctionSecrets } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

export const dynamic = "force-dynamic";

const RESERVED = /^(SUPABASE_|SB_|JWT_SECRET$|VERIFY_JWT$|LEVANT_|DENO_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$)/;

/** GET /api/v1/base/projects/:ref/secrets — Edge Function secrets (names only) — MEMBER. */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  await requireBaseRole(ref, "MEMBER", { scope: "base:read" });
  return json({ items: await listFunctionSecrets(ref) });
});

const schema = z.object({
  set: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "Use UPPER_CASE letters, digits and underscores"),
      z.string().max(64 * 1024),
    )
    .default({}),
  remove: z.array(z.string().max(128)).max(200).default([]),
});

/** PUT { set: {NAME: value}, remove: [NAME] } — ADMIN. Restarts the functions runtime. */
export const PUT = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, schema);
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  const bad = [...Object.keys(input.set), ...input.remove].find((k) => RESERVED.test(k));
  if (bad) throw E.validation({ [`set.${bad}`]: "This name is reserved by the runtime" });
  await setFunctionSecrets(ref, input.set, input.remove, actor.user.id);
  await audit({ action: "base.secrets.update", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, set: Object.keys(input.set), remove: input.remove } });
  return json({ ok: true, items: await listFunctionSecrets(ref) });
});
