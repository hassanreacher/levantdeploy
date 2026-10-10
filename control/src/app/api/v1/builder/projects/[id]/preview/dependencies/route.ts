import { z } from "zod";
import { json, body, throttle } from "@/lib/http";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { addDependency } from "@/lib/builder/preview";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST …/preview/dependencies { packages: ["zod@3"], dev? } → { ok, output, commit } — pnpm add + commit (MEMBER) */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ packages: z.array(z.string().min(1).max(120)).min(1).max(20), dev: z.boolean().default(false) }));
  const { user, actor, team } = await requireBuilder(id, "MEMBER");
  await throttle(`builder-deps:${user.id}`, { limit: 20, window: 600 });
  const r = await addDependency(id, input.packages, { dev: input.dev, author: { name: user.name, email: user.email, userId: user.id } });
  await audit({ action: "builder.add_dependency", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { packages: input.packages, ok: r.ok } });
  return json(r, r.ok ? 200 : 422);
});
