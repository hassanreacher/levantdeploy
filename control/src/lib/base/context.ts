import fs from "node:fs";
import type { BaseProject } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { projectUrl, publicNetwork } from "./config";
import { baseLimitsForTeam, type BaseLimits } from "./limits";
import type { RenderInput } from "./render";
import { decryptSecrets } from "./secrets";
import { readSettings } from "./settings";
import { resolveVersions } from "./versions";

/** Everything needed to render one project's stack, loaded from the DB. */
export async function loadRenderInput(p: BaseProject, overrides: { versions?: Record<string, string> } = {}): Promise<RenderInput & { project: BaseProject }> {
  const settings = readSettings(p.settings);
  const limits: BaseLimits = await baseLimitsForTeam(p.teamId, settings.limits);
  const fns = await db.baseFunction.findMany({ where: { baseProjectId: p.id, verifyJwt: false }, select: { slug: true } });
  let egressCa: string | null = null;
  if (env.BASE_EGRESS_CA_FILE) {
    try {
      egressCa = fs.readFileSync(env.BASE_EGRESS_CA_FILE, "utf8");
    } catch {
      egressCa = null;
    }
  }
  return {
    project: p,
    ref: p.ref,
    secrets: decryptSecrets(p.secretsEnc),
    settings,
    limits,
    versions: resolveVersions(p.versions, overrides.versions),
    publicUrl: projectUrl(p.ref),
    publicNetwork: publicNetwork(),
    mirror: env.BASE_IMAGE_MIRROR ?? null,
    egressProxy: env.BASE_EGRESS_PROXY ?? null,
    egressCa,
    noVerifyJwt: fns.map((f) => f.slug),
    dbPublicPort: limits.publicDbPort ? p.dbPublicPort : null,
    dbPublicBind: env.BASE_DB_PORT_BIND || "0.0.0.0",
  };
}

export async function requireBase(ref: string): Promise<BaseProject> {
  const p = await db.baseProject.findUnique({ where: { ref } });
  if (!p) throw new Error(`base project ${ref} not found`);
  return p;
}
