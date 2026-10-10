import { z } from "zod";
import { query } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { exportZip } from "@/lib/builder/export";

export const dynamic = "force-dynamic";

/** GET …/export.zip[?ref=<sha>] → application/zip of the app's source (committed files) (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ ref: z.string().regex(/^[0-9a-f]{4,40}$/).optional() }));
  const { actor, team } = await requireBuilder(id, "VIEWER");
  const { filename, bytes } = await exportZip(id, { ref: q.ref });
  await audit({ action: "builder.export_zip", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { size: bytes.length } });
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"`, "content-length": String(bytes.length), "cache-control": "no-store" },
  });
});
