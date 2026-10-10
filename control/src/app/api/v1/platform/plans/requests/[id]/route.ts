import { z } from "zod";
import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { db } from "@/lib/db";

/** PATCH /api/v1/platform/plans/requests/:id { status: "DISMISSED" | "APPROVED" } → { request } */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  await requirePlatformOwner();
  const { id } = await params;
  const input = await body(req, z.object({ status: z.enum(["DISMISSED", "APPROVED"]) }));
  const r = await db.planUpgradeRequest.findUnique({ where: { id } });
  if (!r) throw E.notFound("Request not found");
  const request = await db.planUpgradeRequest.update({ where: { id }, data: { status: input.status, handledAt: new Date() } });
  return json({ request });
});
