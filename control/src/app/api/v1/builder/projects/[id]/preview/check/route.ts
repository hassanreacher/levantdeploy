import { z } from "zod";
import { json, body, throttle } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { runCheck } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** POST …/preview/check { kind: "typecheck" | "lint" | "build" } → { kind, ok, summary, diagnostics[], output, durationMs } (MEMBER) */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ kind: z.enum(["typecheck", "lint", "build"]) }));
  const { user } = await requireBuilder(id, "MEMBER");
  await throttle(`builder-check:${user.id}`, { limit: 20, window: 600 });
  return json(await runCheck(id, input.kind));
});
