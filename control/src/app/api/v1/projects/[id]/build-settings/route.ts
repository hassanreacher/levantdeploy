import { z } from "zod";
import { route, json, body, requireProjectRole } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { buildSettingsSchema, parseBuildSettings, FRAMEWORK_PRESETS, type BuildMeta } from "@/lib/build/types";

export const dynamic = "force-dynamic";

const rootDirectory = z
  .string()
  .max(255)
  .transform((s) => s.trim().replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, ""))
  .refine((s) => !s.split("/").includes(".."), "Relative path inside the repository (no ..)");

const putSchema = z.object({
  rootDirectory: rootDirectory.optional(),
  buildSettings: buildSettingsSchema,
});

async function view(projectId: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { id: true, framework: true, kind: true, rootDirectory: true, buildSettings: true, sourceType: true, image: true, port: true } });
  const last = await db.deployment.findFirst({
    where: { projectId, status: { in: ["DEPLOYING", "READY", "SUPERSEDED", "ERROR"] }, buildFinishedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, framework: true, meta: true, status: true, createdAt: true },
  });
  const build = ((last?.meta as Record<string, unknown> | null)?.build ?? null) as BuildMeta | null;
  return {
    projectId: p.id,
    framework: p.framework,
    kind: p.kind,
    sourceType: p.sourceType,
    rootDirectory: p.rootDirectory,
    buildSettings: parseBuildSettings(p.buildSettings),
    presets: FRAMEWORK_PRESETS,
    lastBuild: last
      ? {
          deploymentId: last.id,
          number: last.number,
          status: last.status,
          framework: build?.framework ?? last.framework,
          frameworkName: build?.frameworkName ?? null,
          strategy: build?.strategy ?? null,
          imageSize: build?.imageSize ?? null,
          durationMs: build?.durationMs ?? null,
          createdAt: last.createdAt,
        }
      : null,
  };
}

/** GET /api/v1/projects/:id/build-settings → { projectId, rootDirectory, buildSettings, presets, lastBuild } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  return json(await view(project.id));
});

/**
 * PUT /api/v1/projects/:id/build-settings { rootDirectory?, buildSettings } — replaces the build settings
 * (null / missing field = auto-detect). Applies to the next deployment.
 */
export const PUT = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, putSchema);
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "projects:write" });
  // drop null/empty values: "not overridden"
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.buildSettings)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "buildArgs" && v && typeof v === "object" && !Object.keys(v).length) continue;
    clean[k] = v;
  }
  await db.project.update({
    where: { id: project.id },
    data: {
      buildSettings: clean as object,
      ...(input.rootDirectory !== undefined ? { rootDirectory: input.rootDirectory } : {}),
      ...(clean.framework ? { framework: clean.framework as string } : {}),
    },
  });
  await audit({
    action: "project.build_settings",
    teamId: team.id,
    actor,
    targetType: "project",
    targetId: project.id,
    meta: { keys: Object.keys(clean), rootDirectory: input.rootDirectory ?? project.rootDirectory },
  });
  return json(await view(project.id));
});
