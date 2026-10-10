import { z } from "zod";
import { route, json, query, body, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { createDeployment } from "@/lib/deployments";
import { listDeployments, toDTO } from "@/lib/dashboard/deployments";

export const dynamic = "force-dynamic";

const STATUSES = ["QUEUED", "BUILDING", "DEPLOYING", "READY", "ERROR", "CANCELED", "SUPERSEDED"] as const;
const q = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  target: z.enum(["PRODUCTION", "PREVIEW"]).optional(),
  branch: z.string().max(255).optional(),
  /** comma separated or repeated: status=READY,ERROR */
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : ([] as string[]).concat(v).flatMap((s) => s.split(",")).map((s) => s.trim().toUpperCase()).filter(Boolean)))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  q: z.string().max(200).optional(),
});

/** GET /api/v1/projects/:id/deployments?cursor&limit&target&branch&status&q → { items, next } */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const f = query(req, q);
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "deployments:read" });
  return json(await listDeployments(project.id, f));
});

const createSchema = z.object({
  target: z.enum(["PRODUCTION", "PREVIEW"]).default("PRODUCTION"),
  /** default: the production branch; the build area resolves the latest commit */
  branch: z.string().trim().min(1).max(255).optional(),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
});

/** POST /api/v1/projects/:id/deployments { target?, branch?, commitSha? } (MEMBER) → 201 { deployment }  ("Deploy" button) */
export const POST = route<{ id: string }>(
  async (req, { params }) => {
    const { id } = await params;
    const input = await body(req, createSchema);
    const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "deployments:write" });
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    if (project.pausedAt) throw E.conflict("This project is paused. Resume it before deploying.");
    if (project.sourceType === "UPLOAD") throw E.bad("This project is deployed from uploads. Use `levant deploy` or redeploy an existing deployment.");
    const d = await createDeployment({
      projectId: project.id,
      target: input.target,
      trigger: "MANUAL",
      createdById: actor.user.id,
      source: { branch: input.branch ?? project.productionBranch, commitSha: input.commitSha?.toLowerCase() ?? null },
    });
    await audit({ action: "deployment.create", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number, target: d.target } });
    return json({ deployment: toDTO(d) }, 201);
  },
  { limit: LIMITS.deploy, key: "deploy" },
);
