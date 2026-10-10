import type { Prisma, TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { randomId } from "@/lib/crypto";

/** Paths that can't be a team slug (top-level routes). */
export const RESERVED_TEAM_SLUGS = new Set([
  "api", "login", "register", "logout", "forgot-password", "reset-password", "invite", "account", "dashboard",
  "new", "settings", "docs", "_next", "static", "public", "favicon.ico", "robots.txt", "health",
  "2fa", "auth", "teams", "team", "cli", "oauth", "github", "help", "status", "www",
  // landing area: public marketing pages
  "features", "pricing",
]);

/** Team sub-routes that can't be a project slug (/{team}/{project}). */
export const RESERVED_PROJECT_SLUGS = new Set([
  "settings", "members", "tokens", "audit", "new", "projects", "domains", "databases", "usage", "integrations",
  "notifications", "activity", "~", "api", "ai", "search", "base", "backend",
  // builder-ui: /{team}/build (AI app builder)
  "build",
]);

export function slugify(input: string, max = 40): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "team"
  );
}

export async function uniqueTeamSlug(base: string, tx: Prisma.TransactionClient = db): Promise<string> {
  let slug = slugify(base);
  if (RESERVED_TEAM_SLUGS.has(slug)) slug = `${slug}-team`;
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? slug : `${slug.slice(0, 33)}-${randomId(6)}`;
    const exists = await tx.team.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  throw new Error("Could not allocate team slug");
}

export async function createTeam(
  input: { name: string; slug?: string; ownerId: string; isPersonal?: boolean },
  tx: Prisma.TransactionClient = db,
) {
  const slug = input.slug ? input.slug : await uniqueTeamSlug(input.name, tx);
  return tx.team.create({
    data: {
      name: input.name,
      slug,
      isPersonal: !!input.isPersonal,
      memberships: { create: { userId: input.ownerId, role: "OWNER" } },
    },
  });
}

export async function teamsForUser(userId: string) {
  const rows = await db.membership.findMany({
    where: { userId },
    include: { team: { select: { id: true, name: true, slug: true, avatar: true, isPersonal: true } } },
    orderBy: [{ team: { isPersonal: "desc" } }, { createdAt: "asc" }],
  });
  return rows.map((m) => ({ ...m.team, role: m.role as TeamRole }));
}

export type TeamSummary = Awaited<ReturnType<typeof teamsForUser>>[number];
