import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { addCustomProvider, customProviderSchema, overview } from "@/lib/llm/admin";

/** GET → providers (masked keys, live status + health), preferences, routing. POST → add a custom OpenAI-compatible provider. */
export const GET = route(async () => {
  await requirePlatformOwner();
  return json(await overview());
});

export const POST = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, customProviderSchema);
  try {
    await addCustomProvider(input);
  } catch (e) {
    throw E.conflict((e as Error).message);
  }
  await audit({ action: "platform.ai_provider_add", actor, targetType: "ai_provider", targetId: input.id, meta: { baseUrl: input.baseUrl, withKey: !!input.apiKey } });
  return json({ id: input.id }, 201);
});
