import { z } from "zod";
import type { Notification, NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { decryptJson, decryptString, encryptJson, hmacSha256, randomId } from "@/lib/crypto";
import { sendMail } from "@/lib/email";
import { hostUrl } from "@/lib/deployments";
import { formatDuration } from "@/lib/utils";

/**
 * Notification channels + delivery (dashboard area). Worker-safe.
 *
 * Channels (`Notification` rows, team-wide when projectId is null, else project-scoped):
 *   EMAIL    {to: string[]}                     foundation mailer (SMTP_* or console in dev)
 *   WEBHOOK  {url, secret}                      JSON POST signed with HMAC-SHA256 (see signWebhook)
 *   TELEGRAM {botToken, chatId}                 Bot API sendMessage (HTML)
 *   SLACK    {webhookUrl}                       Incoming webhook (Block Kit)
 *   DISCORD  {webhookUrl}                       Discord webhook (embed)
 * Outgoing `Webhook` rows (team-level signed webhooks) are delivered the same way as WEBHOOK channels.
 */

export const NOTIFY_EVENTS = [
  { value: "deployment.ready", label: "Deployment succeeded" },
  { value: "deployment.error", label: "Deployment failed" },
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]["value"] | "test";

const httpsUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), "Must be an http(s) URL");

export const CHANNEL_CONFIG = {
  EMAIL: z.object({ to: z.array(z.string().email()).min(1).max(20) }),
  WEBHOOK: z.object({ url: httpsUrl, secret: z.string().min(8).max(200) }),
  TELEGRAM: z.object({ botToken: z.string().regex(/^\d+:[\w-]{20,}$/, "Looks like 123456:ABC-DEF…"), chatId: z.string().min(1).max(64) }),
  SLACK: z.object({ webhookUrl: httpsUrl }),
  DISCORD: z.object({ webhookUrl: httpsUrl }),
} satisfies Record<NotificationType, z.ZodTypeAny>;

export type ChannelConfig = { EMAIL: { to: string[] }; WEBHOOK: { url: string; secret: string }; TELEGRAM: { botToken: string; chatId: string }; SLACK: { webhookUrl: string }; DISCORD: { webhookUrl: string } };

/** Public (masked) view of a channel config for the UI — never returns secrets. */
export function maskedConfig(type: NotificationType, configEnc: string): Record<string, string> {
  const c = decryptJson<Record<string, unknown>>(configEnc) ?? {};
  const tail = (s: unknown) => (typeof s === "string" && s ? `••••${s.slice(-4)}` : "");
  const host = (u: unknown) => {
    try {
      const x = new URL(String(u));
      return `${x.protocol}//${x.host}/…`;
    } catch {
      return "";
    }
  };
  switch (type) {
    case "EMAIL":
      return { to: Array.isArray(c.to) ? (c.to as string[]).join(", ") : "" };
    case "WEBHOOK":
      return { url: String(c.url ?? ""), secret: tail(c.secret) };
    case "TELEGRAM":
      return { botToken: tail(c.botToken), chatId: String(c.chatId ?? "") };
    case "SLACK":
    case "DISCORD":
      return { webhookUrl: host(c.webhookUrl) };
  }
}

export const encryptChannelConfig = (c: unknown) => encryptJson(c);

// ───────────────────────────── Payload ─────────────────────────────

export type NotifyPayload = {
  id: string;
  event: NotifyEvent;
  createdAt: string;
  team: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string } | null;
  deployment: {
    id: string;
    number: number;
    shortId: string;
    status: string;
    target: string;
    url: string;
    branch: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    commitAuthor: string | null;
    errorMessage: string | null;
    errorStep: string | null;
    durationMs: number | null;
    inspectUrl: string;
  } | null;
};

export async function buildPayload(event: NotifyEvent, ids: { deploymentId?: string; projectId?: string; teamId?: string }): Promise<NotifyPayload | null> {
  const dep = ids.deploymentId ? await db.deployment.findUnique({ where: { id: ids.deploymentId }, include: { project: { include: { team: true } } } }) : null;
  const project = dep?.project ?? (ids.projectId ? await db.project.findUnique({ where: { id: ids.projectId }, include: { team: true } }) : null);
  const team = project?.team ?? (ids.teamId ? await db.team.findUnique({ where: { id: ids.teamId } }) : null);
  if (!team) return null;
  return {
    id: `evt_${randomId(16)}`,
    event,
    createdAt: new Date().toISOString(),
    team: { id: team.id, slug: team.slug, name: team.name },
    project: project ? { id: project.id, slug: project.slug, name: project.name } : null,
    deployment:
      dep && project
        ? {
            id: dep.id,
            number: dep.number,
            shortId: dep.shortId,
            status: dep.status,
            target: dep.target,
            url: hostUrl(dep.url),
            branch: dep.branch,
            commitSha: dep.commitSha,
            commitMessage: dep.commitMessage,
            commitAuthor: dep.commitAuthor,
            errorMessage: dep.errorMessage,
            errorStep: dep.errorStep,
            durationMs: dep.duration,
            inspectUrl: appUrl(`/${team.slug}/${project.slug}/deployments/${dep.id}`),
          }
        : null,
  };
}

/** Sample payload for the "Send test" button. */
export function testPayload(team: { id: string; slug: string; name: string }): NotifyPayload {
  return {
    id: `evt_${randomId(16)}`,
    event: "test",
    createdAt: new Date().toISOString(),
    team,
    project: null,
    deployment: null,
  };
}

export function messageFor(p: NotifyPayload): { title: string; text: string; ok: boolean } {
  if (p.event === "test" || !p.deployment || !p.project) {
    return { title: "LevantDeploy test notification", text: `Notifications for team “${p.team.name}” are working.`, ok: true };
  }
  const d = p.deployment;
  const ok = p.event === "deployment.ready";
  const target = d.target === "PRODUCTION" ? "Production" : "Preview";
  const title = ok ? `✅ ${p.project.name}: ${target} deployment #${d.number} is ready` : `❌ ${p.project.name}: ${target} deployment #${d.number} failed`;
  const lines = [
    d.branch ? `Branch: ${d.branch}${d.commitSha ? ` @ ${d.commitSha.slice(0, 7)}` : ""}` : null,
    d.commitMessage ? `Commit: ${d.commitMessage.split("\n")[0]!.slice(0, 140)}${d.commitAuthor ? ` — ${d.commitAuthor}` : ""}` : null,
    ok ? `URL: ${d.url}` : `Error${d.errorStep ? ` (${d.errorStep.toLowerCase()})` : ""}: ${(d.errorMessage ?? "unknown error").slice(0, 300)}`,
    d.durationMs != null ? `Duration: ${formatDuration(d.durationMs)}` : null,
    `Inspect: ${d.inspectUrl}`,
  ].filter(Boolean) as string[];
  return { title, text: lines.join("\n"), ok };
}

// ───────────────────────────── Senders ─────────────────────────────

/** `X-Levant-Signature: t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>` — verify with the same secret, reject if |now - t| > 5 min. */
export function signWebhook(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${hmacSha256(secret, `${ts}.${body}`)}`;
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "LevantDeploy-Notifier/1.0", ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (res.status >= 300) {
    const t = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${t ? `: ${t}` : ""}`);
  }
  return { status: res.status };
}

export async function deliverWebhook(url: string, secret: string, p: NotifyPayload) {
  const body = JSON.stringify(p);
  return post(url, body, { "x-levant-event": p.event, "x-levant-delivery": p.id, "x-levant-signature": signWebhook(secret, body) });
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendChannel(type: NotificationType, config: unknown, p: NotifyPayload): Promise<void> {
  const m = messageFor(p);
  switch (type) {
    case "EMAIL": {
      const c = CHANNEL_CONFIG.EMAIL.parse(config);
      const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5"><h2 style="font-size:16px">${esc(m.title)}</h2><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px;background:#f6f6f6;padding:12px;border-radius:8px">${esc(m.text)}</pre></div>`;
      for (const to of c.to) await sendMail({ to, subject: m.title, text: m.text, html });
      return;
    }
    case "WEBHOOK": {
      const c = CHANNEL_CONFIG.WEBHOOK.parse(config);
      await deliverWebhook(c.url, c.secret, p);
      return;
    }
    case "TELEGRAM": {
      const c = CHANNEL_CONFIG.TELEGRAM.parse(config);
      const text = `<b>${esc(m.title)}</b>\n${esc(m.text)}`;
      await post(`https://api.telegram.org/bot${c.botToken}/sendMessage`, JSON.stringify({ chat_id: c.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }));
      return;
    }
    case "SLACK": {
      const c = CHANNEL_CONFIG.SLACK.parse(config);
      await post(
        c.webhookUrl,
        JSON.stringify({
          text: m.title,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${m.title}*` } },
            { type: "section", text: { type: "mrkdwn", text: "```" + m.text + "```" } },
          ],
        }),
      );
      return;
    }
    case "DISCORD": {
      const c = CHANNEL_CONFIG.DISCORD.parse(config);
      await post(
        c.webhookUrl,
        JSON.stringify({
          username: "LevantDeploy",
          embeds: [{ title: m.title.slice(0, 250), description: m.text.slice(0, 4000), color: m.ok ? 0x45c478 : 0xff5555, url: p.deployment?.inspectUrl }],
        }),
      );
      return;
    }
  }
}

/** Sends to one stored channel and records lastSentAt / lastError. Returns the error message or null. */
export async function sendToChannel(ch: Notification, p: NotifyPayload): Promise<string | null> {
  try {
    const config = decryptJson(ch.configEnc);
    if (!config) throw new Error("Channel config can't be decrypted (ENCRYPTION_KEY changed?)");
    await sendChannel(ch.type, config, p);
    await db.notification.update({ where: { id: ch.id }, data: { lastSentAt: new Date(), lastError: null } }).catch(() => {});
    return null;
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 500) || "failed";
    await db.notification.update({ where: { id: ch.id }, data: { lastError: msg } }).catch(() => {});
    return msg;
  }
}

/**
 * Full fan-out for a deployment event: channels (team + project scoped, enabled, subscribed to the event),
 * outgoing Webhook rows, and in-app notifications for every team member. Idempotent for the in-app part.
 */
export async function dispatchEvent(event: NotifyEvent, ids: { deploymentId?: string; projectId?: string; teamId?: string }) {
  const p = await buildPayload(event, ids);
  if (!p) return { sent: 0, failed: 0, errors: [] as string[] };
  const projectId = p.project?.id ?? null;
  const channels = await db.notification.findMany({
    where: { teamId: p.team.id, enabled: true, events: { has: event }, OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] },
  });
  const hooks = await db.webhook.findMany({
    where: { teamId: p.team.id, enabled: true, events: { has: event }, OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] },
  });
  const errors: string[] = [];
  let sent = 0;
  for (const ch of channels) {
    const err = await sendToChannel(ch, p);
    if (err) errors.push(`${ch.name}: ${err}`);
    else sent++;
  }
  for (const h of hooks) {
    try {
      const secret = decryptString(h.secretEnc) ?? "";
      const r = await deliverWebhook(h.url, secret, p);
      await db.webhook.update({ where: { id: h.id }, data: { lastDeliveryAt: new Date(), lastStatus: r.status, lastError: null } });
      sent++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      errors.push(`webhook ${h.url}: ${msg}`);
      await db.webhook.update({ where: { id: h.id }, data: { lastDeliveryAt: new Date(), lastError: msg } }).catch(() => {});
    }
  }
  if (p.deployment && p.project) await createInbox(p, event);
  return { sent, failed: errors.length, errors };
}

/** In-app (bell) notifications for every member of the team. */
export async function createInbox(p: NotifyPayload, event: NotifyEvent) {
  if (!p.deployment || !p.project) return;
  const members = await db.membership.findMany({ where: { teamId: p.team.id }, select: { userId: true } });
  const m = messageFor(p);
  const d = p.deployment;
  await db.userNotification.createMany({
    skipDuplicates: true,
    data: members.map((x) => ({
      userId: x.userId,
      teamId: p.team.id,
      projectId: p.project!.id,
      deploymentId: d.id,
      kind: event,
      title: m.title.replace(/^[✅❌]\s*/, ""),
      body: event === "deployment.error" ? (d.errorMessage ?? "Deployment failed").slice(0, 300) : (d.commitMessage?.split("\n")[0]?.slice(0, 200) ?? d.url),
      href: `/${p.team.slug}/${p.project!.slug}/deployments/${d.id}`,
      dedupeKey: `${event}:${d.id}:${d.status}`,
    })),
  });
}
