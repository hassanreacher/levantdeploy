import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decryptJson } from "@/lib/crypto";
import { CHANNEL_CONFIG, encryptChannelConfig, maskedConfig, NOTIFY_EVENTS } from "@/lib/dashboard/notify";

const schema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    events: z.array(z.enum(NOTIFY_EVENTS.map((e) => e.value) as [string, ...string[]])).min(1),
    /** partial config: empty strings keep the stored secret */
    config: z.record(z.unknown()),
  })
  .partial();

/** PATCH /api/v1/teams/:team/notifications/:id (ADMIN) */
export const PATCH = route<{ team: string; id: string }>(async (req, { params }) => {
  const { team, id } = await params;
  const input = await body(req, schema);
  const { team: t, actor } = await requireTeamRole(team, "ADMIN");
  const cur = await db.notification.findFirst({ where: { id, teamId: t.id } });
  if (!cur) throw E.notFound("Channel not found");
  let configEnc: string | undefined;
  if (input.config) {
    const prev = decryptJson<Record<string, unknown>>(cur.configEnc) ?? {};
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(input.config)) if (v !== "" && v !== undefined && v !== null) merged[k] = v;
    configEnc = encryptChannelConfig(CHANNEL_CONFIG[cur.type].parse(merged));
  }
  const row = await db.notification.update({ where: { id }, data: { name: input.name, enabled: input.enabled, events: input.events, ...(configEnc ? { configEnc } : {}) } });
  await audit({ action: "notification.update", teamId: t.id, actor, targetType: "notification", targetId: id, meta: { name: row.name } });
  const { configEnc: c, ...rest } = row;
  return json({ item: { ...rest, config: maskedConfig(row.type, c) } });
});

/** DELETE /api/v1/teams/:team/notifications/:id (ADMIN) */
export const DELETE = route<{ team: string; id: string }>(async (_req, { params }) => {
  const { team, id } = await params;
  const { team: t, actor } = await requireTeamRole(team, "ADMIN");
  const cur = await db.notification.findFirst({ where: { id, teamId: t.id } });
  if (!cur) throw E.notFound("Channel not found");
  await db.notification.delete({ where: { id } });
  await audit({ action: "notification.delete", teamId: t.id, actor, targetType: "notification", targetId: id, meta: { name: cur.name, type: cur.type } });
  return json({ ok: true });
});
