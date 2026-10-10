import type { Project } from "@prisma/client";
import { db } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { projectHost } from "@/lib/deployments";

export function platformDomain(): string {
  return (process.env.PLATFORM_DOMAIN || "levant.localhost").toLowerCase();
}

/** Free subdomain `{slug}.{PLATFORM_DOMAIN}` — created automatically (ACTIVE) on the first deploy / domains page visit. */
export async function ensurePlatformDomain(project: Pick<Project, "id" | "slug">) {
  const existing = await db.domain.findFirst({ where: { projectId: project.id, kind: "PLATFORM" } });
  if (existing) return existing;
  let host = projectHost(project.slug);
  // another project (other team, same slug) already owns it → suffix
  for (let i = 0; i < 5 && (await db.domain.findUnique({ where: { hostname: host } })); i++) {
    host = projectHost(`${project.slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`);
  }
  const hasPrimary = await db.domain.count({ where: { projectId: project.id, isPrimary: true } });
  try {
    return await db.domain.create({
      data: {
        projectId: project.id,
        hostname: host,
        kind: "PLATFORM",
        status: "ACTIVE",
        verifyToken: randomToken(16),
        verifiedAt: new Date(),
        certStatus: "PENDING",
        isPrimary: hasPrimary === 0,
      },
    });
  } catch {
    // concurrent creation
    return db.domain.findFirst({ where: { projectId: project.id, kind: "PLATFORM" } });
  }
}
