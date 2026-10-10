import { route, json } from "@/lib/http";
import { audit } from "@/lib/audit";
import { connectionInfo } from "@/lib/runtime/databases";
import { requireDatabase } from "@/lib/runtime/api";

export const dynamic = "force-dynamic";

/** GET /api/v1/databases/:id/credentials → { user, password, database, host, port, internalUrl, publicUrl, envNames } (ADMIN, audited) */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  const host = new URL(req.url).hostname;
  const info = connectionInfo(database, host === "localhost" || host === "127.0.0.1" ? undefined : host);
  await audit({ action: "database.reveal_credentials", teamId: team.id, actor, targetType: "database", targetId: id, meta: { name: database.name } });
  return json(info, { headers: { "cache-control": "no-store" } });
});
