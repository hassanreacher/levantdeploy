import { z } from "zod";
import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { parseCaBundle, platformBuildView, savePlatformBuild } from "@/lib/build/platform";

export const dynamic = "force-dynamic";

/** GET /api/v1/platform/build → build proxy (passwords masked), CA certificates, registry mirror, limits (owner only). */
export const GET = route(async () => {
  await requirePlatformOwner();
  return json(await platformBuildView());
});

const proxyUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^(https?|socks5h?):\/\/[^\s]+$/i.test(v), "Use http://host:port (optionally user:password@)")
  .transform((v) => v || null)
  .nullable()
  .optional();

const schema = z.object({
  /** null disables the build proxy entirely */
  proxy: z
    .object({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: z.string().trim().max(4000).regex(/^[^\s]*$/, "Comma-separated, no spaces").nullable().optional(),
      caCertPem: z.string().trim().max(256 * 1024, "CA bundle too large (max 256 KB)").nullable().optional(),
      network: z.enum(["host", "default"]).optional(),
    })
    .nullable()
    .optional(),
  /** Docker Hub pull-through mirror for generated base images, e.g. "mirror.gcr.io" */
  registryMirror: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
    .refine((v) => v === "" || /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]+)?$/i.test(v), "A registry host like mirror.gcr.io")
    .nullable()
    .optional(),
});

/** PUT /api/v1/platform/build { proxy?, registryMirror? } (owner only) */
export const PUT = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, schema);
  if (input.proxy?.caCertPem) {
    try {
      if (!parseCaBundle(input.proxy.caCertPem).length) throw new Error("no certificate");
    } catch {
      throw E.validation({ "proxy.caCertPem": "Paste one or more PEM certificates (-----BEGIN CERTIFICATE-----)" });
    }
  }
  const changed = await savePlatformBuild(input);
  await audit({ action: "platform.build_settings", actor, targetType: "setting", meta: { changed } });
  return json(await platformBuildView());
});
