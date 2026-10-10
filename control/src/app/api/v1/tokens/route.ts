import { z } from "zod";
import { route, json, body, query, requireSession, requireTeamRole, throttle } from "@/lib/http";
import { db } from "@/lib/db";
import { createApiToken, TOKEN_SCOPES } from "@/lib/auth/tokens";
import { audit } from "@/lib/audit";

/** List my tokens (optionally only those scoped to ?team=slug). Tokens are managed with a session only. */
export const GET = route(async (req) => {
  const s = await requireSession();
  const { team } = query(req, z.object({ team: z.string().optional() }));
  let teamId: string | undefined;
  if (team) teamId = (await requireTeamRole(team, "VIEWER")).team.id;
  const tokens = await db.apiToken.findMany({
    where: { userId: s.user.id, revokedAt: null, ...(teamId ? { OR: [{ teamId }, { teamId: null }] } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, scopes: true, teamId: true, team: { select: { slug: true, name: true } }, lastUsedAt: true, expiresAt: true, createdAt: true },
  });
  return json({ tokens });
});

const schema = z.object({
  name: z.string().trim().min(1, "Give the token a name").max(60),
  /** team id or slug; omit for an all-teams token */
  team: z.string().optional().nullable(),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).default(["*"]),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
});

/** Create a token. The plain token is in the response ONCE. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const input = await body(req, schema);
  await throttle(`token-create:${s.user.id}`, { limit: 20, window: 3600 });
  let teamId: string | null = null;
  if (input.team) teamId = (await requireTeamRole(input.team, "MEMBER")).team.id;
  const { token, row } = await createApiToken({
    userId: s.user.id,
    teamId,
    name: input.name,
    scopes: input.scopes,
    expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null,
  });
  await audit({ action: "token.create", teamId, userId: s.user.id, targetType: "api_token", targetId: row.id, meta: { name: row.name, scopes: row.scopes } });
  return json({ token, id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expiresAt }, 201);
});
