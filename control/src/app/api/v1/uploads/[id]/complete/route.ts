import { z } from "zod";
import { route, json, body, requireApiTokenOrSession, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { completeUpload, UploadError } from "@/lib/uploads/storage";

export const dynamic = "force-dynamic";

/** POST /api/v1/uploads/:id/complete { sha256? } → { id, status: "COMPLETE", size, sha256 } */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }));
  const actor = await requireApiTokenOrSession({ scope: "deployments:write" });
  const up = await db.upload.findUnique({ where: { id } });
  if (!up) throw E.notFound("Upload not found");
  await requireTeamRole(up.teamId, "MEMBER", { actor });
  if (up.userId && up.userId !== actor.user.id) throw E.forbidden("This upload belongs to another user");
  const sha = input.sha256 ?? (await redis().get(`ld:upload:${id}:sha`));
  try {
    const done = await completeUpload(up, sha);
    return json({ id: done.id, status: done.status, size: done.size, sha256: done.sha256, expiresAt: done.expiresAt });
  } catch (e) {
    if (e instanceof UploadError) throw e.status === 409 ? E.conflict(e.message) : E.bad(e.message);
    throw e;
  }
});
