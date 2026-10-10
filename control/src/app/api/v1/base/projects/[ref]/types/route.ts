import { z } from "zod";
import { route, query, throttle, E } from "@/lib/http";
import { requireBaseRole } from "@/lib/base-ui/access";
import { generateTypes } from "@/lib/base/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/base/projects/:ref/types?lang=typescript&schemas=public,other — VIEWER (base:read).
 * TypeScript definitions of the database (postgres-meta generator, same output as `supabase gen types typescript`).
 * Used by `levant base gen types typescript`. (compat area)
 */
export const GET = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const q = query(req, z.object({ lang: z.enum(["typescript"]).default("typescript"), schemas: z.string().max(500).optional() }));
  const { base, actor } = await requireBaseRole(ref, "VIEWER");
  await throttle(`base:types:${actor.user.id}`, { limit: 30, window: 60 });
  if (base.status !== "ACTIVE") throw E.conflict("The project is not running");
  const schemas = (q.schemas ?? "public").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const ts = await generateTypes(ref, { schemas });
    return new Response(ts, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (e) {
    throw E.bad((e as Error).message.slice(0, 500));
  }
});
