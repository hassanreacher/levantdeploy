import { route, json, requireApiTokenOrSession, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { receivedChunks } from "@/lib/uploads/storage";

export const dynamic = "force-dynamic";

/** GET /api/v1/uploads/:id → { id, status, size, totalChunks, received: number[] } (resume support) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const actor = await requireApiTokenOrSession({ scope: "deployments:read" });
  const up = await db.upload.findUnique({ where: { id } });
  if (!up) throw E.notFound("Upload not found");
  await requireTeamRole(up.teamId, "VIEWER", { actor });
  return json({
    id: up.id,
    status: up.status,
    size: up.size,
    sha256: up.sha256,
    totalChunks: up.totalChunks,
    received: up.status === "PENDING" ? await receivedChunks(up.id) : [],
    expiresAt: up.expiresAt,
    projectId: up.projectId,
  });
});
