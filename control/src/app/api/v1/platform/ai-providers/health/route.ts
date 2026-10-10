import { route, json, requirePlatformOwner } from "@/lib/http";
import { llm } from "@/lib/llm";

/** GET → live health of every provider + curated model (status dots poll this). */
export const GET = route(async () => {
  await requirePlatformOwner();
  const providers = await llm.providers();
  return json({ providers: providers.map((p) => ({ id: p.id, status: p.status, health: p.health })), items: await llm.healthAll() });
});
