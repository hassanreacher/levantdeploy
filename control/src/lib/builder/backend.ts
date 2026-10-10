import { db } from "@/lib/db";
import { baseEnvVars, baseKeys, createBaseProject, getBaseProject } from "@/lib/base";
import { writeEnvLocal, removeEnvLocal } from "./workspace";
import { isPreviewRunning, requestPreview } from "./preview";

/**
 * Backend link (builder-core): a builder app gets one LevantBase backend.
 *   attachBackend(id, { ref })        attach an existing Base project of the same team
 *   attachBackend(id, { create })     create one (owned by the Deploy project when it already exists)
 *   attachBackend(id)                 reuse the attached one, or the Deploy project's backend, or create
 * Writes `.env.local` in the workspace (preview only — gitignored, never committed or published; the published
 * Deploy project gets its env vars through the "connect" integration on publish) and restarts a running preview.
 * Provisioning is asynchronous: status PROVISIONING → ACTIVE (≈ 30–90 s); keys/env are valid immediately.
 * Worker-safe.
 */

export class BackendError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AttachResult = { ref: string; url: string; anonKey: string; status: string; created: boolean; envKeys: string[] };

export async function attachBackend(builderId: string, opts: { ref?: string | null; create?: boolean; userId?: string | null; restartPreview?: boolean } = {}): Promise<AttachResult> {
  const bp = await db.builderProject.findUnique({ where: { id: builderId } });
  if (!bp) throw new BackendError(404, "App not found");
  let ref: string | null = null;
  let created = false;
  if (opts.ref) {
    const b = await getBaseProject(opts.ref);
    if (!b || b.teamId !== bp.teamId) throw new BackendError(404, "Backend not found in this team");
    if (b.status === "DELETING") throw new BackendError(409, "This backend is being deleted");
    ref = b.ref;
  } else if (!opts.create && bp.baseRef && (await getBaseProject(bp.baseRef))) {
    ref = bp.baseRef;
  } else if (!opts.create && bp.projectId) {
    const owned = await db.baseProject.findUnique({ where: { projectId: bp.projectId }, select: { ref: true } });
    ref = owned?.ref ?? null;
  }
  if (!ref) {
    const projectHasBackend = bp.projectId ? await db.baseProject.findUnique({ where: { projectId: bp.projectId }, select: { id: true } }) : null;
    const b = await createBaseProject({
      teamId: bp.teamId,
      name: `${bp.name}`.slice(0, 60) || "app",
      createdById: opts.userId ?? bp.createdById ?? null,
      projectId: bp.projectId && !projectHasBackend ? bp.projectId : null,
    });
    ref = b.ref;
    created = true;
  }
  if (bp.baseRef !== ref) await db.builderProject.update({ where: { id: builderId }, data: { baseRef: ref } });
  const vars = await baseEnvVars(ref);
  // the preview runs on levant_net → server-side code may use the internal URL; browsers need the public one
  await writeEnvLocal(builderId, vars);
  const keys = await baseKeys(ref);
  const base = await getBaseProject(ref);
  if (opts.restartPreview !== false && (await isPreviewRunning(builderId))) await requestPreview(builderId, "restart", { byUserId: opts.userId, reason: "backend attached" });
  return { ref, url: keys.url, anonKey: keys.anonKey, status: base?.status ?? "PROVISIONING", created, envKeys: Object.keys(vars) };
}

/** Detach (the Base project itself is kept). Removes the preview's .env.local. */
export async function detachBackend(builderId: string, opts: { restartPreview?: boolean } = {}) {
  await db.builderProject.update({ where: { id: builderId }, data: { baseRef: null } });
  await removeEnvLocal(builderId);
  if (opts.restartPreview !== false && (await isPreviewRunning(builderId))) await requestPreview(builderId, "restart", { reason: "backend detached" });
}

/** Re-write .env.local from the attached backend (e.g. after key rotation / workspace re-creation). */
export async function syncBackendEnv(builderId: string): Promise<string[]> {
  const bp = await db.builderProject.findUnique({ where: { id: builderId }, select: { baseRef: true } });
  if (!bp?.baseRef) return [];
  const vars = await baseEnvVars(bp.baseRef);
  await writeEnvLocal(builderId, vars);
  return Object.keys(vars);
}
