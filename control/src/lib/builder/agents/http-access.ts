/**
 * Access check for the run APIs (Next-only: imports @/lib/http via builder-core's access helper — never import from worker code).
 * MEMBER may start/cancel runs, VIEWER may read them. Non-members get 404.
 */
import { requireBuilder } from "@/lib/builder/access";

export async function requireBuilderProject(id: string, min: "VIEWER" | "MEMBER", scope: "projects:read" | "projects:write") {
  const { builder, actor, team } = await requireBuilder(id, min, scope);
  return { project: builder, actor, team };
}
