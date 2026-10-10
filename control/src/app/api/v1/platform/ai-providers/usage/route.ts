import { z } from "zod";
import { route, json, query, requirePlatformOwner } from "@/lib/http";
import { usageStats } from "@/lib/llm/admin";

/** GET ?range=24h|7d|30d → per provider/model requests, errors, tokens, avg latency + recent errors. */
export const GET = route(async (req) => {
  await requirePlatformOwner();
  const { range } = query(req, z.object({ range: z.enum(["24h", "7d", "30d"]).default("24h") }));
  return json(await usageStats(range));
});
