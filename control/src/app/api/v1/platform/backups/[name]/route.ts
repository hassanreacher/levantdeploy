import fs from "node:fs";
import { Readable } from "node:stream";
import { route, requirePlatformOwner, json, E } from "@/lib/http";
import { backupPath } from "@/lib/ops/backup";
import { audit } from "@/lib/audit";

/** GET → download one control-DB backup file. DELETE → remove it. */
export const GET = route<{ name: string }>(async (_req, { params }) => {
  const actor = await requirePlatformOwner();
  const { name } = await params;
  const file = backupPath(name);
  if (!file) throw E.notFound();
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) throw E.notFound();
  await audit({ action: "platform.backup_download", actor, targetType: "backup", targetId: name });
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
});

export const DELETE = route<{ name: string }>(async (_req, { params }) => {
  const actor = await requirePlatformOwner();
  const { name } = await params;
  const file = backupPath(name);
  if (!file) throw E.notFound();
  await fs.promises.rm(file, { force: true });
  await audit({ action: "platform.backup_delete", actor, targetType: "backup", targetId: name });
  return json({ ok: true });
});
