import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { hasRole } from "@/lib/auth/roles";
import { getGitHubApp } from "@/lib/github/config";
import { readFlowState, exchangeUserCode, userCanAccessInstallation } from "@/lib/github/manifest";
import { syncInstallation } from "@/lib/github/installations";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/github/callback?installation_id&setup_action&state[&code]
 * GitHub's setup URL / OAuth callback after installing the app. Links the installation to the team from `state`.
 * Ownership check: when GitHub sent an OAuth `code` (request_oauth_on_install), the GitHub user must have access to the
 * installation; without it only the platform owner may link installations.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const session = await getSession();
  if (!session) return NextResponse.redirect(appUrl(`/login?next=${encodeURIComponent(url.pathname + url.search)}`));
  const state = await readFlowState(url.searchParams.get("state"), { consume: true });
  const installationId = Number(url.searchParams.get("installation_id"));
  const teamSlug = state?.teamSlug ?? null;
  const back = (q: string) => NextResponse.redirect(appUrl(teamSlug ? `/${teamSlug}/new?${q}` : `/?${q}`));
  if (!installationId) return back("github_error=" + encodeURIComponent("Missing installation id"));
  if (!state || state.kind !== "install" || state.userId !== session.user.id) return back("github_error=" + encodeURIComponent("Invalid or expired state — start the installation from LevantDeploy"));

  const team = await db.team.findFirst({ where: { slug: teamSlug ?? "" } });
  const m = team ? await db.membership.findUnique({ where: { teamId_userId: { teamId: team.id, userId: session.user.id } } }) : null;
  if (!team || !m || !hasRole(m.role, "MEMBER")) return back("github_error=" + encodeURIComponent("Team not found"));

  const app = await getGitHubApp();
  const code = url.searchParams.get("code");
  let verified = false;
  if (code && app?.clientId && app.clientSecret) {
    const userToken = await exchangeUserCode(app.clientId, app.clientSecret, code).catch(() => null);
    verified = !!userToken && (await userCanAccessInstallation(userToken, installationId).catch(() => false));
    if (!verified) return back("github_error=" + encodeURIComponent("Your GitHub account cannot access this installation"));
  } else if (!session.user.isPlatformOwner) {
    return back("github_error=" + encodeURIComponent("Ask the platform owner to enable OAuth for the GitHub App (client id/secret) or to link this installation"));
  }
  try {
    const row = await syncInstallation(installationId, team.id);
    await audit({ action: "github.install", teamId: team.id, userId: session.user.id, targetType: "github_installation", targetId: row.id, meta: { account: row.accountLogin, setupAction: url.searchParams.get("setup_action") } });
  } catch (e) {
    return back("github_error=" + encodeURIComponent(`Could not read the installation: ${(e as Error).message}`));
  }
  return back("github_installed=1");
}
