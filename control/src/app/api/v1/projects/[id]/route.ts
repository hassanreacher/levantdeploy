import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { route, json, body, requireProjectRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { stackAction } from "@/lib/base-ui/adapters";
import { hasRole } from "@/lib/auth/roles";
import { queues } from "@/lib/queues";
import { getSetting } from "@/lib/settings";
import { RESERVED_PROJECT_SLUGS } from "@/lib/teams";
import { publicProtection, readProtection } from "@/lib/dashboard/protection";
import { requestSync } from "@/lib/proxy/sync";

export const dynamic = "force-dynamic";

function projectView(p: Prisma.ProjectGetPayload<object>) {
  // never expose encrypted columns (deploy key, git credentials)
  const { gitDeployKeyEnc: _k, protection, ...rest } = p as typeof p & { gitSettings?: unknown };
  delete (rest as { gitSettings?: unknown }).gitSettings;
  return { ...rest, protection: publicProtection(protection) };
}

/** GET /api/v1/projects/:id → { project } (no secrets) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  return json({ project: projectView(project) });
});

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const RESTART = ["no", "always", "unless-stopped", "on-failure"] as const;

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z.string().trim().toLowerCase().regex(SLUG_RE, "Lowercase letters, digits and dashes (max 50)"),
    description: z.string().max(500).nullable(),
    framework: z.string().max(40).nullable(),
    kind: z.enum(["WEB", "WORKER", "STATIC", "COMPOSE"]),
    rootDirectory: z.string().max(255).regex(/^(?!\/)(?!.*\.\.)/, "Relative path without ..").transform((s) => s.replace(/^\.\/?/, "").replace(/\/$/, "")),
    productionBranch: z.string().trim().min(1).max(255),
    /** merged into the stored object (null removes a key) — owned by the build area's form */
    buildSettings: z.record(z.unknown()),
    port: z.number().int().min(1).max(65535),
    healthcheckPath: z.string().max(255).regex(/^\//, "Must start with /").nullable(),
    replicas: z.number().int().min(0).max(64),
    cpuLimit: z.number().min(0.05).max(256).nullable(),
    memoryLimitMb: z.number().int().min(32).max(1024 * 1024).nullable(),
    restartPolicy: z.enum(RESTART),
    autoDeploy: z.boolean(),
    previewDeployments: z.boolean(),
    /** merged into the stored object (null removes a key) */
    runtimeSettings: z.record(z.unknown()),
    protection: z.object({
      mode: z.enum(["none", "password", "basic"]),
      scope: z.enum(["previews", "all"]).default("previews"),
      username: z.string().trim().min(1).max(64).optional(),
      /** omit to keep the current password */
      password: z.string().min(6).max(128).optional(),
    }),
  })
  .partial();

const RUNTIME_KEYS = ["port", "healthcheckPath", "replicas", "cpuLimit", "memoryLimitMb", "restartPolicy", "runtimeSettings", "kind"] as const;

function merge(cur: unknown, patch: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...((cur as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as Prisma.InputJsonObject;
}

/**
 * PATCH /api/v1/projects/:id — partial update of general / build / runtime / protection settings.
 * MEMBER for build & runtime settings; ADMIN for slug and deployment protection.
 * → { project, needsRedeploy } (runtime/build changes apply on the next deployment)
 */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, patchSchema);
  const { project, team, actor, role } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  await throttle(`project:${actor.user.id}`);
  const data: Prisma.ProjectUpdateInput = {};
  const changed: string[] = [];
  if (input.slug !== undefined && input.slug !== project.slug) {
    if (!hasRole(role, "ADMIN")) throw E.forbidden("Changing the project URL requires the admin role");
    if (RESERVED_PROJECT_SLUGS.has(input.slug)) throw E.validation({ slug: "This name is reserved" });
    const clash = await db.project.findUnique({ where: { teamId_slug: { teamId: team.id, slug: input.slug } }, select: { id: true } });
    if (clash) throw E.validation({ slug: "Another project in this team already uses this name" });
    data.slug = input.slug;
  }
  if (input.protection) {
    if (!hasRole(role, "ADMIN")) throw E.forbidden("Deployment protection requires the admin role");
    const cur = readProtection(project.protection);
    const next = { mode: input.protection.mode, scope: input.protection.scope, username: cur.username, passwordHash: cur.passwordHash, updatedAt: new Date().toISOString() };
    if (input.protection.mode === "basic") next.username = input.protection.username ?? cur.username ?? "levant";
    if (input.protection.password) next.passwordHash = await bcrypt.hash(input.protection.password, 10);
    if (input.protection.mode !== "none" && !next.passwordHash) throw E.validation({ "protection.password": "Set a password" });
    if (input.protection.mode === "none") {
      next.passwordHash = undefined;
      next.username = undefined;
    }
    data.protection = JSON.parse(JSON.stringify(next));
  }
  if (input.replicas !== undefined) {
    const lim = await getSetting("limits.defaults");
    if (input.replicas > lim.maxReplicas) throw E.validation({ replicas: `Max ${lim.maxReplicas} replicas on this server` });
  }
  for (const k of ["name", "description", "framework", "kind", "rootDirectory", "productionBranch", "port", "healthcheckPath", "replicas", "cpuLimit", "memoryLimitMb", "restartPolicy", "autoDeploy", "previewDeployments"] as const) {
    if (input[k] !== undefined && input[k] !== project[k]) (data as Record<string, unknown>)[k] = input[k];
  }
  if (input.buildSettings) data.buildSettings = merge(project.buildSettings, input.buildSettings);
  if (input.runtimeSettings) data.runtimeSettings = merge(project.runtimeSettings, input.runtimeSettings);
  changed.push(...Object.keys(data));
  if (!changed.length) return json({ project: projectView(project), needsRedeploy: false });
  const updated = await db.project.update({ where: { id: project.id }, data });
  // runtime: protection / slug (branch aliases) / kind (worker = no routes) change the proxy config
  if (data.protection || data.slug || data.kind) requestSync();
  const needsRedeploy = changed.some((k) => (RUNTIME_KEYS as readonly string[]).includes(k) || ["buildSettings", "rootDirectory", "framework"].includes(k));
  await audit({ action: "project.update", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { fields: changed } });
  return json({ project: projectView(updated), needsRedeploy });
});

/**
 * DELETE /api/v1/projects/:id (ADMIN). Body/query `confirm` must equal the project slug.
 * Rows cascade; containers/images/volumes are removed by the cleanup worker (labels levant.project=<id>).
 */
export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const confirm = new URL(req.url).searchParams.get("confirm");
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  if (confirm !== project.slug) throw E.validation({ confirm: `Type "${project.slug}" to confirm` });
  // base-dashboard: ?backend=keep (default — the backend becomes standalone via onDelete SetNull) | delete
  const backendChoice = new URL(req.url).searchParams.get("backend") === "delete" ? "delete" : "keep";
  const backend = await db.baseProject.findUnique({ where: { projectId: project.id }, select: { id: true, ref: true, name: true, status: true } });
  if (backend && backendChoice === "delete" && backend.status !== "DELETING") {
    await stackAction(backend.ref, "delete", { actorId: actor.user.id });
    await audit({ action: "base.delete", teamId: team.id, actor, targetType: "base_project", targetId: backend.id, meta: { ref: backend.ref, name: backend.name, via: "project.delete" } });
  }
  await db.project.delete({ where: { id: project.id } });
  await queues.cleanup.add({ kind: "all", projectId: project.id }).catch(() => {});
  await audit({ action: "project.delete", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { name: project.name, slug: project.slug, ...(backend ? { backend: backend.ref, backendChoice } : {}) } });
  return json({ ok: true });
});
