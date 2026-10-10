import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { route, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { backupFilePath, backupStorageFilePath } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/backups/:backupId/download[?part=storage] — ADMIN (a dump contains every row + password hashes). Audited. */
export const GET = route<{ ref: string; backupId: string }>(async (req, { params }) => {
  const storage = new URL(req.url).searchParams.get("part") === "storage";
  const { ref, backupId } = await params;
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN", { scope: "base:read" });
  const b = await db.baseBackup.findFirst({ where: { id: backupId, baseProjectId: base.id } });
  if (!b) throw E.notFound("Backup not found");
  if (b.status !== "SUCCEEDED") throw E.conflict("This backup is not finished");
  const file = storage ? await backupStorageFilePath(b) : await backupFilePath(b);
  let size = 0;
  try {
    if (!file) throw new Error("missing");
    size = statSync(file).size;
  } catch {
    throw E.notFound("The backup file is missing");
  }
  await audit({ action: "base.backup.download", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, backupId, part: storage ? "storage" : "sql" } });
  const stamp = b.createdAt.toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return new Response(Readable.toWeb(createReadStream(file!)) as ReadableStream, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${base.ref}-${stamp}${storage ? "-storage.tar.gz" : ".sql.gz"}"`,
      "cache-control": "no-store",
    },
  });
});
