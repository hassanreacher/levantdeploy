import { z } from "zod";
import { cleanHost } from "@/lib/proxy/hosts";
import { readCookie } from "@/lib/proxy/protection";
import { rateLimit } from "@/lib/rate-limit";
import { builderIdFromHost } from "@/lib/builder/host";
import { PREVIEW_COOKIE, checkPreviewCookie, recordPreviewError } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";

const schema = z.object({
  message: z.string().min(1).max(4000),
  stack: z.string().max(8000).optional(),
  source: z.string().max(40).default("runtime"),
  route: z.string().max(300).optional(),
});

/**
 * POST preview-{id}.{PLATFORM_DOMAIN}/__levant/errors — browser errors forwarded by the levant-bridge (dev only).
 * Requires the preview cookie (members / share-link viewers); 60 errors per minute per preview.
 */
export async function POST(req: Request) {
  const id = builderIdFromHost(cleanHost(req.headers.get("x-levant-original-host") ?? ""));
  if (!id) return new Response(null, { status: 404 });
  const ok = await checkPreviewCookie(readCookie(req.headers.get("cookie"), PREVIEW_COOKIE), id).catch(() => null);
  if (!ok) return new Response(null, { status: 401 });
  const rl = await rateLimit(`builder-preview-errors:${id}`, 60, 60).catch(() => ({ ok: true }));
  if (!rl.ok) return new Response(null, { status: 429 });
  let data: unknown;
  try {
    data = JSON.parse((await req.text()).slice(0, 20_000));
  } catch {
    return new Response(null, { status: 400 });
  }
  const p = schema.safeParse(data);
  if (!p.success) return new Response(null, { status: 422 });
  await recordPreviewError(id, p.data);
  return new Response(null, { status: 204 });
}
