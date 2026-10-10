import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CHANNEL_CONFIG, encryptChannelConfig, maskedConfig, NOTIFY_EVENTS } from "@/lib/dashboard/notify";

export const dynamic = "force-dynamic";

/** GET /api/v1/teams/:team/notifications[?projectId=] → { items } (configs masked) */
export const GET = route<{ team: string }>(async (req, { params }) => {
  const { team } = await params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const { team: t } = await requireTeamRole(team, "VIEWER");
  const rows = await db.notification.findMany({
    where: { teamId: t.id, ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}) },
    orderBy: { createdAt: "asc" },
    include: { project: { select: { id: true, name: true, slug: true } } },
  });
  return json({
    items: rows.map(({ configEnc, ...r }) => ({ ...r, config: maskedConfig(r.type, configEnc) })),
  });
});

const EVENT_ENUM = z.enum(NOTIFY_EVENTS.map((e) => e.value) as [string, ...string[]]);

const createSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("EMAIL"), config: CHANNEL_CONFIG.EMAIL }),
  z.object({ type: z.literal("WEBHOOK"), config: CHANNEL_CONFIG.WEBHOOK }),
  z.object({ type: z.literal("TELEGRAM"), config: CHANNEL_CONFIG.TELEGRAM }),
  z.object({ type: z.literal("SLACK"), config: CHANNEL_CONFIG.SLACK }),
  z.object({ type: z.literal("DISCORD"), config: CHANNEL_CONFIG.DISCORD }),
]);
const common = z.object({
  name: z.string().trim().min(1).max(80),
  events: z.array(EVENT_ENUM).min(1).default(["deployment.error"]),
  projectId: z.string().max(64).nullish(),
  enabled: z.boolean().default(true),
});

/** POST /api/v1/teams/:team/notifications { type, name, config, events, projectId? } (ADMIN) → 201 { item } */
export const POST = route<{ team: string }>(async (req, { params }) => {
  const { team } = await params;
  const raw = await body(req, z.record(z.unknown()));
  const input = { ...common.parse(raw), ...createSchema.parse(raw) };
  const { team: t, actor } = await requireTeamRole(team, "ADMIN");
  if (input.projectId) {
    const p = await db.project.findFirst({ where: { id: input.projectId, teamId: t.id }, select: { id: true } });
    if (!p) throw E.validation({ projectId: "Unknown project" });
  }
  const row = await db.notification.create({
    data: { teamId: t.id, projectId: input.projectId ?? null, type: input.type, name: input.name, events: input.events, enabled: input.enabled, configEnc: encryptChannelConfig(input.config) },
  });
  await audit({ action: "notification.create", teamId: t.id, actor, targetType: "notification", targetId: row.id, meta: { type: row.type, name: row.name } });
  const { configEnc, ...rest } = row;
  return json({ item: { ...rest, config: maskedConfig(row.type, configEnc) } }, 201);
});
