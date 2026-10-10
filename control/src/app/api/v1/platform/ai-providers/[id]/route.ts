import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { isBuiltin, providerExists, providerPatchSchema, removeProvider, updateProvider } from "@/lib/llm/admin";

/** PATCH → update a provider (apiKey "" clears it; the key is encrypted and never returned). DELETE → custom: remove, built-in: reset overrides. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const actor = await requirePlatformOwner();
  if (!(await providerExists(id))) throw E.notFound("Unknown provider");
  const input = await body(req, providerPatchSchema);
  const { changed } = await updateProvider(id, input);
  await audit({ action: "platform.ai_provider_update", actor, targetType: "ai_provider", targetId: id, meta: { changed } });
  return json({ ok: true, changed });
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const actor = await requirePlatformOwner();
  if (!(await providerExists(id))) throw E.notFound("Unknown provider");
  await removeProvider(id);
  await audit({ action: isBuiltin(id) ? "platform.ai_provider_reset" : "platform.ai_provider_delete", actor, targetType: "ai_provider", targetId: id });
  return json({ ok: true });
});
