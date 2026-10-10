import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { getSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { convertManifest, readFlowState, createFlowState } from "@/lib/github/manifest";
import { githubWebUrl } from "@/lib/github/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/github/app/callback?code&state — GitHub redirects here after the manifest flow.
 * Converts the code into credentials (stored encrypted), then sends the owner straight to "Install".
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fail = (msg: string, team?: string | null) => NextResponse.redirect(appUrl(`/${team || ""}${team ? "/new" : ""}?github_error=${encodeURIComponent(msg)}`));
  const session = await getSession();
  if (!session) return NextResponse.redirect(appUrl(`/login?next=${encodeURIComponent(url.pathname + url.search)}`));
  const state = await readFlowState(url.searchParams.get("state"), { consume: true });
  if (!state || state.kind !== "manifest" || state.userId !== session.user.id || !session.user.isPlatformOwner) return fail("Invalid or expired state — start again");
  const code = url.searchParams.get("code");
  if (!code) return fail("GitHub did not return a code", state.teamSlug);
  try {
    const app = await convertManifest(code);
    await audit({ action: "github.app_configure", userId: session.user.id, meta: { appId: String(app.appId), slug: app.slug, method: "manifest" } });
    const install = await createFlowState({ kind: "install", userId: session.user.id, teamSlug: state.teamSlug ?? null });
    return NextResponse.redirect(`${githubWebUrl()}/apps/${app.slug}/installations/new?state=${install}`);
  } catch (e) {
    return fail(`Could not create the GitHub App: ${(e as Error).message}`, state.teamSlug);
  }
}
