import { z } from "zod";
import { route, json, body, requireProjectRole, throttle, E, requireApiTokenOrSession } from "@/lib/http";
import { redis } from "@/lib/redis";
import { resolveTeam } from "@/lib/git/team";
import { initUpload, UploadError, maxUploadBytes } from "@/lib/uploads/storage";
import { assertWithinUploadLimit } from "@/lib/plans/enforce";

export const dynamic = "force-dynamic";

const schema = z.object({
  team: z.string().max(60).optional(),
  projectId: z.string().max(40).optional(),
  size: z.number().int().positive(),
  chunkSize: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

/**
 * POST /api/v1/uploads { team?|projectId?, size, chunkSize?, sha256? }
 *   → 201 { id, chunkSize, totalChunks, expiresAt, maxSize }
 * Then PUT /api/v1/uploads/:id/chunks/:index (raw bytes) for every chunk and POST /api/v1/uploads/:id/complete { sha256 }.
 */
export const POST = route(async (req) => {
  const input = await body(req, schema);
  const actor = await requireApiTokenOrSession({ scope: "deployments:write" });
  const pa = input.projectId ? await requireProjectRole(input.projectId, "MEMBER", { actor }) : null;
  const access = pa ?? (await resolveTeam(input.team, "MEMBER", { actor }));
  await throttle(`upload:${actor.user.id}`, { limit: 60, window: 3600 });
  await assertWithinUploadLimit(access.team.id, input.size, "deploy"); // plans area (402 PLAN_LIMIT)
  try {
    const { upload, chunkSize } = await initUpload({
      teamId: access.team.id,
      projectId: pa?.project.id ?? null,
      userId: actor.user.id,
      size: input.size,
      chunkSize: input.chunkSize,
    });
    await redis().set(`ld:upload:${upload.id}:chunk`, String(chunkSize), "EX", 26 * 3600);
    if (input.sha256) await redis().set(`ld:upload:${upload.id}:sha`, input.sha256.toLowerCase(), "EX", 26 * 3600);
    return json({ id: upload.id, chunkSize, totalChunks: upload.totalChunks, expiresAt: upload.expiresAt, maxSize: await maxUploadBytes() }, 201);
  } catch (e) {
    if (e instanceof UploadError) throw e.status === 413 ? E.validation({ size: e.message }, e.message) : E.bad(e.message);
    throw e;
  }
});
