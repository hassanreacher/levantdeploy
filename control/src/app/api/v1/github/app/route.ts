import { z } from "zod";
import { route, json, body, requireApiTokenOrSession, requirePlatformOwner, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { gitHubAppStatus, saveGitHubApp, deleteGitHubApp } from "@/lib/github/config";
import { createAppJwt } from "@/lib/github/jwt";
import { gh } from "@/lib/github/api";

export const dynamic = "force-dynamic";

/** GET /api/v1/github/app → { configured, appId?, slug?, installUrl?, … } (no secrets) */
export const GET = route(async () => {
  await requireApiTokenOrSession();
  return json(await gitHubAppStatus());
});

const manual = z.object({
  appId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/i, "The app's URL name (github.com/apps/<slug>)").max(100),
  privateKey: z.string().includes("PRIVATE KEY", { message: "Paste the .pem private key" }).max(10_000),
  webhookSecret: z.string().min(8).max(200),
  clientId: z.string().max(100).optional().nullable(),
  clientSecret: z.string().max(200).optional().nullable(),
});

/** POST /api/v1/github/app — manual credentials (platform owner). Verified against GitHub (GET /app) before saving. */
export const POST = route(async (req) => {
  const input = await body(req, manual);
  const actor = await requirePlatformOwner();
  let htmlUrl: string | null = null;
  try {
    const jwt = await createAppJwt({ appId: String(input.appId), privateKey: input.privateKey });
    const app = await gh<{ slug: string; html_url: string }>("GET", "/app", { jwt });
    htmlUrl = app.html_url;
    if (app.slug && app.slug !== input.slug) input.slug = app.slug;
  } catch (e) {
    throw E.validation({ privateKey: "GitHub rejected these credentials" }, `Could not verify the app with GitHub: ${(e as Error).message}`);
  }
  await saveGitHubApp({ ...input, htmlUrl });
  await audit({ action: "github.app_configure", actor, meta: { appId: String(input.appId), slug: input.slug, method: "manual" } });
  return json(await gitHubAppStatus(), 201);
});

/** DELETE /api/v1/github/app — forget the credentials (installations rows are kept). */
export const DELETE = route(async () => {
  const actor = await requirePlatformOwner();
  await deleteGitHubApp();
  await audit({ action: "github.app_remove", actor });
  return json({ ok: true });
});
