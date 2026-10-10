import { z } from "zod";
import { route, json, body } from "@/lib/http";
import { resolveTeam } from "@/lib/git/team";
import { createPendingKey } from "@/lib/git/pending-keys";
import { repoNameFromUrl } from "@/lib/git/url";

export const dynamic = "force-dynamic";

/** POST /api/v1/git/deploy-keys { team?, url? } → { id, publicKey, fingerprint } — a deploy key for the import flow (valid 2 h). */
export const POST = route(
  async (req) => {
    const input = await body(req, z.object({ team: z.string().max(60).optional(), url: z.string().max(1000).optional() }));
    const { team } = await resolveTeam(input.team, "MEMBER", { scope: "projects:write" });
    const name = input.url ? repoNameFromUrl(input.url) : "project";
    return json(await createPendingKey(team.id, `levantdeploy-${team.slug}-${name}`), 201);
  },
  { limit: { limit: 20, window: 60 }, key: "deploy-key" },
);
