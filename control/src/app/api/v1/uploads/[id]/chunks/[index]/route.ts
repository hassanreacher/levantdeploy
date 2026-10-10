import { route, json, requireApiTokenOrSession, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { writeChunk, UploadError, DEFAULT_CHUNK_SIZE } from "@/lib/uploads/storage";

export const dynamic = "force-dynamic";

/** PUT /api/v1/uploads/:id/chunks/:index — raw bytes (application/octet-stream). Idempotent. → { received, total } */
export const PUT = route<{ id: string; index: string }>(
  async (req, { params }) => {
    const { id, index } = await params;
    const actor = await requireApiTokenOrSession({ scope: "deployments:write" });
    const up = await db.upload.findUnique({ where: { id } });
    if (!up) throw E.notFound("Upload not found");
    await requireTeamRole(up.teamId, "MEMBER", { actor });
    if (up.userId && up.userId !== actor.user.id) throw E.forbidden("This upload belongs to another user");
    const chunkSize = Number(await redis().get(`ld:upload:${id}:chunk`)) || DEFAULT_CHUNK_SIZE;
    const data = new Uint8Array(await req.arrayBuffer());
    try {
      return json(await writeChunk(up, Number(index), data, chunkSize));
    } catch (e) {
      if (e instanceof UploadError) throw e.status === 409 ? E.conflict(e.message) : e.status === 410 ? E.bad(e.message) : E.bad(e.message);
      throw e;
    }
  },
  { limit: { limit: 2000, window: 60 }, key: "upload-chunk" },
);
