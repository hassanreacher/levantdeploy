import { route, json, requirePlatformOwner, E } from "@/lib/http";
import { providerExists, refreshModels } from "@/lib/llm/admin";
import { LlmError } from "@/lib/llm";

/** POST → fetch GET {base}/models now and cache it (Setting llm.modelsCache). */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requirePlatformOwner();
  if (!(await providerExists(id))) throw E.notFound("Unknown provider");
  try {
    return json(await refreshModels(id));
  } catch (e) {
    const msg = e instanceof LlmError ? `${e.code}: ${e.message}` : (e as Error).message;
    throw E.bad(msg.slice(0, 300));
  }
});
