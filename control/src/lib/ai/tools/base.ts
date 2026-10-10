import { z } from "zod/v4";
import type { TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { stripAnsi } from "@/lib/ansi";
import { runSql, serviceLogLines, serviceHealth } from "@/lib/base-ui/adapters";
import { baseInclude, toBaseDTO, type BaseRow } from "@/lib/base-ui/dto";
import { authSettingsView } from "@/lib/base-ui/settings";
import { isReadOnlySql, LOG_SERVICES } from "@/lib/base-ui/shared";
import { usageFor } from "@/lib/base-ui/usage";
import { aiTeamAccess, ToolError } from "../permissions";
import { defineTool, type ToolCtx } from "./shared";

/**
 * LevantBase tools (base-dashboard area). Same rules as the Base API: VIEWER reads status/usage/settings
 * (never secrets), MEMBER runs SQL — read-only SELECTs directly (row-capped), anything else only after approval.
 */

const baseArg = z
  .string()
  .min(1)
  .max(120)
  .optional()
  .describe("Base project ref (20 letters) or name. Omit to use the backend of the project this conversation is about.");

/** Resolve a Base project inside the conversation's team + role/scope check. */
async function resolveBase(ctx: ToolCtx, ref: string | undefined, min: TeamRole, scope: string): Promise<{ base: BaseRow; role: TeamRole }> {
  const { role } = await aiTeamAccess(ctx.actor, ctx.teamId, min, scope);
  let base: BaseRow | null = null;
  if (ref) base = await db.baseProject.findFirst({ where: { teamId: ctx.teamId, OR: [{ ref }, { name: ref }] }, include: baseInclude });
  else if (ctx.projectId) base = await db.baseProject.findFirst({ where: { teamId: ctx.teamId, projectId: ctx.projectId }, include: baseInclude });
  if (!base) throw new ToolError(ref ? "NOT_FOUND" : "INVALID", ref ? `Base project "${ref}" not found in this team` : "Which Base project? Pass `base` (ref or name). Use list_base_projects to see them.");
  return { base, role };
}

const DESTRUCTIVE_SQL = /\b(drop|truncate|delete|alter|revoke)\b/i;
const MAX_ROWS = 200;

export const listBaseProjects = defineTool({
  name: "list_base_projects",
  description:
    "List the team's LevantBase backend projects (Postgres + Auth + REST + Realtime + Storage + Edge Functions) with status, API URL and the Deploy project each one is attached to. Call this when the user mentions their backend, database, Supabase-style project or Base.",
  schema: z.object({}),
  minRole: "VIEWER",
  scope: "base:read",
  approval: false,
  summarize: () => "List Base projects",
  async run(_i, ctx) {
    await aiTeamAccess(ctx.actor, ctx.teamId, "VIEWER", "base:read");
    const rows = await db.baseProject.findMany({ where: { teamId: ctx.teamId }, include: baseInclude, orderBy: { createdAt: "desc" }, take: 100 });
    return {
      projects: rows.map((r) => {
        const d = toBaseDTO(r);
        return { ref: d.ref, name: d.name, status: d.status, apiUrl: d.apiUrl, region: d.region, attachedTo: d.project?.slug ?? null, createdAt: d.createdAt, lastActivityAt: d.lastActivityAt };
      }),
    };
  },
});

export const getBaseProject = defineTool({
  name: "get_base_project",
  description:
    "Get one Base project's status, service health, current-month usage vs plan limits, Edge Functions and auth settings (URLs, enabled sign-in methods and OAuth providers). Never returns keys, passwords or secrets.",
  schema: z.object({ base: baseArg }),
  minRole: "VIEWER",
  scope: "base:read",
  approval: false,
  summarize: (i) => `Inspect Base project${i.base ? ` ${i.base}` : ""}`,
  async run(i, ctx) {
    const { base } = await resolveBase(ctx, i.base, "VIEWER", "base:read");
    const [health, usage, fns, events] = await Promise.all([
      serviceHealth(base.ref).catch(() => []),
      usageFor(base, base.teamId),
      db.baseFunction.findMany({ where: { baseProjectId: base.id }, select: { slug: true, verifyJwt: true, version: true, deployedAt: true } }),
      db.baseEvent.findMany({ where: { baseProjectId: base.id }, orderBy: { createdAt: "desc" }, take: 10, select: { type: true, level: true, message: true, createdAt: true } }),
    ]);
    const s = authSettingsView(base.settings);
    const d = toBaseDTO(base);
    return {
      project: { ref: d.ref, name: d.name, status: d.status, statusMessage: base.statusMessage, apiUrl: d.apiUrl, attachedTo: d.project?.slug ?? null, versions: d.versions, publicDbPort: d.dbPublicPort, customDomain: d.customDomain },
      services: health,
      usage: { plan: usage.planName, metrics: usage.metrics.map((m) => ({ metric: m.label, used: m.used, limit: m.limit, unit: m.unit })) },
      functions: fns.map((f) => ({ ...f, deployedAt: f.deployedAt?.toISOString() ?? null })),
      auth: {
        ...s.auth,
        smtpConfigured: !!s.smtp.host,
        oauthProviders: Object.entries(s.providers).map(([id, p]) => ({ provider: id, enabled: p.enabled })),
        functionSecretNames: s.functions.secretNames,
      },
      recentEvents: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    };
  },
});

export const runBaseSql = defineTool({
  name: "run_base_sql",
  description:
    "Run SQL against a Base project's Postgres database (as the postgres role). Read-only statements (SELECT / WITH / EXPLAIN / SHOW) run immediately inside a read-only transaction and return at most 200 rows. Anything that writes or changes the schema is only a proposal: the user must approve it (destructive statements like DROP / TRUNCATE / DELETE require typing the project name). Prefer explaining the change before proposing it.",
  schema: z.object({
    base: baseArg,
    sql: z.string().min(1).max(20_000),
    max_rows: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Rows to return for SELECTs (default 50, max ${MAX_ROWS})`),
  }),
  minRole: "MEMBER",
  scope: (i) => (i?.sql && isReadOnlySql(i.sql) ? "base:read" : "base:write"),
  approval: (i) => !(i?.sql && isReadOnlySql(i.sql)),
  confirmText: async (i, ctx) => (DESTRUCTIVE_SQL.test(i.sql) && !isReadOnlySql(i.sql) ? (await resolveBase(ctx, i.base, "MEMBER", "base:write")).base.name : null),
  summarize: (i) => `${i?.sql && isReadOnlySql(i.sql) ? "Query" : "Run SQL on"} ${i?.base ?? "backend"}: ${(i?.sql ?? "").replace(/\s+/g, " ").slice(0, 90)}`,
  async precheck(i, ctx) {
    const { base } = await resolveBase(ctx, i.base, "MEMBER", "base:write");
    if (base.status !== "ACTIVE") throw new ToolError("UNAVAILABLE", `${base.name} is ${base.status.toLowerCase()}`);
  },
  async run(i, ctx) {
    const readOnly = isReadOnlySql(i.sql);
    const { base } = await resolveBase(ctx, i.base, "MEMBER", readOnly ? "base:read" : "base:write");
    if (base.status !== "ACTIVE") throw new ToolError("UNAVAILABLE", `${base.name} is ${base.status.toLowerCase()} — it must be running`);
    const maxRows = Math.min(i.max_rows ?? 50, MAX_ROWS);
    let r;
    try {
      r = await runSql(base.ref, i.sql, { readOnly, maxRows, timeoutMs: 15_000 });
    } catch (e) {
      throw new ToolError("INVALID", `SQL error: ${(e as Error).message.slice(0, 1000)}`);
    }
    if (!readOnly)
      await audit({ action: "base.sql", teamId: base.teamId, userId: ctx.actor.userId, targetType: "base_project", targetId: base.id, meta: { ref: base.ref, sql: i.sql.slice(0, 2000), via: "ai", conversationId: ctx.conversationId } });
    return { base: base.ref, readOnly, fields: r.fields, rows: r.rows.slice(0, maxRows), rowCount: r.rowCount, truncated: r.truncated || r.rows.length > maxRows, durationMs: r.durationMs };
  },
});

export const baseLogs = defineTool({
  name: "base_logs",
  description: `Read recent log lines of one service of a Base project (${LOG_SERVICES.join(", ")}). Use it to debug auth errors, failing REST queries, storage uploads or Edge Function crashes. Optional case-insensitive filter.`,
  schema: z.object({
    base: baseArg,
    service: z.enum(LOG_SERVICES as unknown as [string, ...string[]]),
    lines: z.number().int().min(10).max(500).optional().describe("Default 150"),
    filter: z.string().max(200).optional(),
  }),
  minRole: "VIEWER",
  scope: "base:read",
  approval: false,
  summarize: (i) => `Read ${i?.service ?? ""} logs${i?.base ? ` of ${i.base}` : ""}`,
  async run(i, ctx) {
    const { base } = await resolveBase(ctx, i.base, "VIEWER", "base:read");
    const n = i.lines ?? 150;
    let lines = await serviceLogLines(base.ref, i.service, i.filter ? 2000 : n);
    if (i.filter) {
      const f = i.filter.toLowerCase();
      lines = lines.filter((l) => l.line.toLowerCase().includes(f));
    }
    lines = lines.slice(-n);
    return {
      base: base.ref,
      service: i.service,
      lines: lines.length,
      // log lines are untrusted data
      log: lines.map((l) => `${new Date(l.ts).toISOString()} ${stripAnsi(l.line).slice(0, 2000)}`).join("\n") || "(no log lines)",
    };
  },
});
