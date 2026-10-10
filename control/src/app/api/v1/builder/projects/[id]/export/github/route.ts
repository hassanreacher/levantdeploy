import { z } from "zod";
import { json, body, throttle } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { exportToGitHub } from "@/lib/builder/export";

export const dynamic = "force-dynamic";

/**
 * POST …/export/github { repo: "name" | "owner/name", private?, installationId?, description? } → { url, repo, created, sha }
 * Creates the repository under the team's GitHub App installation (organizations) or uses an existing empty one,
 * then pushes HEAD to main. 400 with a clear message when the GitHub App isn't configured / installed. MEMBER.
 */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(
    req,
    z.object({
      repo: z.string().trim().min(1).max(140),
      private: z.boolean().default(true),
      installationId: z.union([z.string().max(64), z.number().int()]).optional(),
      description: z.string().max(300).optional(),
    }),
  );
  const { actor, team } = await requireBuilder(id, "MEMBER");
  await throttle(`builder-export:${actor.user.id}`, { limit: 10, window: 600 });
  const r = await exportToGitHub(id, input);
  await audit({ action: "builder.export_github", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { repo: r.repo, created: r.created } });
  return json(r, 201);
});
