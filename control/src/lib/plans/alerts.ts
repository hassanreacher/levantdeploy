import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { queues } from "@/lib/queues";
import { sendMail } from "@/lib/email";
import { dayKey, monthKey, usageReport, type UsageItem, type UsageReport } from "./usage";

/**
 * Quota warnings (plans area). Worker-safe.
 *  - checkQuotas(teamId): computes usage, records PlanUsageAlert rows (deduped per resource/period/level) and
 *    enqueues `notify` jobs { event: "plan.quota_warning" (80 %) | "plan.quota_exceeded" (100 %), teamId, payload }.
 *  - dispatchPlanEvent(): called by the notify processor for "plan.*" events → in-app notifications (owners + admins)
 *    and email to the owners at 100 %; "plan.upgrade_request" → platform owners.
 */

export const PLAN_EVENTS = ["plan.quota_warning", "plan.quota_exceeded", "plan.upgrade_request"] as const;
export type PlanEvent = (typeof PLAN_EVENTS)[number];
export const isPlanEvent = (e: string): e is PlanEvent => (PLAN_EVENTS as readonly string[]).includes(e);

/** resources never alerted: transient gauges */
const NO_ALERT = new Set(["deploy.concurrentBuilds"]);

export type QuotaPayload = {
  resource: string;
  label: string;
  used: number;
  limit: number;
  unit: UsageItem["unit"];
  level: 80 | 100;
  enforced: boolean;
  scope?: UsageItem["scope"];
  plan: string;
};

export function alertLevel(i: Pick<UsageItem, "limit" | "ratio">): 80 | 100 | null {
  if (i.limit === null) return null;
  if (i.ratio >= 1) return 100;
  if (i.ratio >= 0.8) return 80;
  return null;
}

export async function checkQuotas(teamId: string, opts: { report?: UsageReport; now?: Date; enqueue?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const report = opts.report ?? (await usageReport(teamId, { now }));
  const sent: QuotaPayload[] = [];
  for (const i of report.all) {
    if (NO_ALERT.has(i.resource) || i.limit === null) continue;
    const level = alertLevel(i);
    if (!level) continue;
    const period = i.period === "day" ? dayKey(now) : monthKey(now);
    const resource = i.scope ? `${i.resource}@${i.scope.id}` : i.resource;
    const levels = level === 100 ? [100, 80] : [80];
    let created = false;
    for (const l of levels) {
      const r = await db.planUsageAlert.createMany({ data: [{ teamId, resource, period, level: l, used: i.used, limit: i.limit }], skipDuplicates: true });
      if (l === level && r.count > 0) created = true;
    }
    if (!created) continue;
    const payload: QuotaPayload = { resource: i.resource, label: i.label, used: i.used, limit: i.limit, unit: i.unit, level, enforced: i.enforced, scope: i.scope, plan: report.plan.name };
    sent.push(payload);
    if (opts.enqueue !== false) {
      await queues.notify
        .add({ event: level === 100 ? "plan.quota_exceeded" : "plan.quota_warning", teamId, payload: payload as unknown as Record<string, unknown> })
        .catch((e) => console.warn("[plans] notify enqueue failed:", (e as Error).message));
    }
  }
  return { report, sent };
}

/** Every team (worker tick). */
export async function checkAllQuotas() {
  const teams = await db.team.findMany({ select: { id: true } });
  let alerts = 0;
  for (const t of teams) {
    try {
      alerts += (await checkQuotas(t.id)).sent.length;
    } catch (e) {
      console.warn(`[plans] quota check ${t.id} failed:`, (e as Error).message);
    }
  }
  return { teams: teams.length, alerts };
}

const fmt = (n: number, unit: UsageItem["unit"]) => (unit === "count" ? n.toLocaleString("en-US") : `${n.toLocaleString("en-US")} ${unit}`);

export function quotaMessage(p: QuotaPayload, teamName: string) {
  const what = `${p.label}${p.scope ? ` (${p.scope.name})` : ""}`;
  const title = p.level === 100 ? `${teamName}: ${what} limit reached` : `${teamName}: ${what} at ${Math.round((p.used / p.limit) * 100)}%`;
  const body =
    `${fmt(p.used, p.unit)} of ${fmt(p.limit, p.unit)} on the ${p.plan} plan.` +
    (p.level === 100 ? (p.enforced ? " New usage of this resource is restricted until the next period or an upgrade." : " (warning only — not enforced)") : "");
  return { title, body };
}

export async function dispatchPlanEvent(event: PlanEvent, data: { teamId?: string; payload?: Record<string, unknown> }) {
  if (!data.teamId) return { skipped: "no team" };
  const team = await db.team.findUnique({ where: { id: data.teamId }, select: { id: true, slug: true, name: true } });
  if (!team) return { skipped: "team gone" };
  const href = `/${team.slug}/settings/plan`;

  if (event === "plan.upgrade_request") {
    const p = (data.payload ?? {}) as { requestId?: string; plan?: string | null; message?: string | null; by?: string };
    const owners = await db.user.findMany({ where: { isPlatformOwner: true, disabledAt: null }, select: { id: true, email: true } });
    const title = `Plan upgrade requested by ${team.name}`;
    const body = `${p.by ?? "A team member"} asked for ${p.plan ? `the ${p.plan} plan` : "a bigger plan"}${p.message ? `: “${p.message.slice(0, 200)}”` : "."}`;
    await db.userNotification.createMany({
      skipDuplicates: true,
      data: owners.map((o) => ({ userId: o.id, teamId: team.id, kind: event, title, body, href: "/settings/plans", dedupeKey: `${event}:${p.requestId ?? Date.now()}` })),
    });
    for (const o of owners) await sendMail({ to: o.email, subject: title, text: `${body}\n\nAssign a plan: ${appUrl("/settings/plans")}` }).catch(() => {});
    return { notified: owners.length };
  }

  const p = data.payload as unknown as QuotaPayload;
  const m = quotaMessage(p, team.name);
  const members = await db.membership.findMany({ where: { teamId: team.id, role: { in: ["OWNER", "ADMIN"] } }, select: { role: true, user: { select: { id: true, email: true } } } });
  const key = `${event}:${p.resource}:${p.scope?.id ?? ""}:${p.level}:${p.level === 100 && p.resource === "deploy.deploymentsPerDay" ? dayKey() : monthKey()}`;
  await db.userNotification.createMany({
    skipDuplicates: true,
    data: members.map((x) => ({ userId: x.user.id, teamId: team.id, kind: event, title: m.title, body: m.body, href, dedupeKey: key })),
  });
  let emailed = 0;
  if (event === "plan.quota_exceeded") {
    for (const x of members.filter((x) => x.role === "OWNER")) {
      await sendMail({ to: x.user.email, subject: m.title, text: `${m.body}\n\nSee usage and upgrade: ${appUrl(href)}` })
        .then(() => emailed++)
        .catch(() => {});
    }
  }
  return { inApp: members.length, emailed };
}
