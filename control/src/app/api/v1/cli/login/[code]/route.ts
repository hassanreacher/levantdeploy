import { z } from "zod";
import { route, json, body, requireSession, requireTeamRole, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { describeUserCode, decideUserCode } from "@/lib/git/cli-auth";

export const dynamic = "force-dynamic";

/** GET /api/v1/cli/login/:code → { userCode, status, clientName, hostname, ip, createdAt } (session) */
export const GET = route<{ code: string }>(async (_req, { params }) => {
  const { code } = await params;
  await requireSession();
  const d = await describeUserCode(code);
  if (!d) throw E.notFound("This code is invalid or expired. Run `levant login` again.");
  return json(d);
});

/** POST /api/v1/cli/login/:code { action: "approve" | "deny", team? } (session; same-origin) */
export const POST = route<{ code: string }>(async (req, { params }) => {
  const { code } = await params;
  const input = await body(req, z.object({ action: z.enum(["approve", "deny"]), team: z.string().max(60).optional().nullable() }));
  const s = await requireSession();
  let teamId: string | null = null;
  let teamSlug: string | null = null;
  if (input.team) {
    const t = await requireTeamRole(input.team, "VIEWER");
    teamId = t.team.id;
    teamSlug = t.team.slug;
  }
  const status = await decideUserCode(code, input.action, s.user, { teamId, teamSlug });
  if (!status) throw E.notFound("This code is invalid or expired. Run `levant login` again.");
  await audit({ action: input.action === "approve" ? "token.create" : "cli.login_deny", userId: s.user.id, teamId, meta: { via: "cli-login" } });
  return json({ status });
});
