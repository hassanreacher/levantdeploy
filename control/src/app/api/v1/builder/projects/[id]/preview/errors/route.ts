import { z } from "zod";
import { json, body } from "@/lib/http";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { clearPreviewErrors, getPreviewErrors, recordPreviewError } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

/** GET …/preview/errors → { items: [{ id, at, source, message, stack?, route?, file? }] } current errors, newest first (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireBuilder(id, "VIEWER");
  return json({ items: await getPreviewErrors(id) });
});

/** POST …/preview/errors { message, stack?, source?, route? } — the editor relays a bridge error (MEMBER) */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ message: z.string().min(1).max(4000), stack: z.string().max(8000).optional(), source: z.string().max(40).default("runtime"), route: z.string().max(300).optional() }));
  await requireBuilder(id, "MEMBER");
  return json({ item: await recordPreviewError(id, input) }, 201);
});

/** DELETE …/preview/errors — clear (MEMBER) */
export const DELETE = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireBuilder(id, "MEMBER");
  await clearPreviewErrors(id);
  return json({ ok: true });
});
