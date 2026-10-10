import { z } from "zod";
import { route, json, body, throttle, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { runSql } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { isReadOnlySql } from "@/lib/base-ui/shared";

/**
 * POST /api/v1/base/projects/:ref/sql { sql, maxRows? } — MEMBER (spec: members may use SQL / Studio).
 * Read-only statements run in a read-only transaction; anything else is audited with the statement text.
 */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, z.object({ sql: z.string().trim().min(1).max(5 * 1024 * 1024, "SQL is limited to 5 MB"), maxRows: z.number().int().min(1).max(5000).default(500) }));
  const { base, team, actor } = await requireBaseRole(ref, "MEMBER");
  await throttle(`base:sql:${actor.user.id}`, { limit: 60, window: 60 });
  if (base.status !== "ACTIVE") throw E.conflict("The project is not running");
  const readOnly = isReadOnlySql(input.sql);
  try {
    const r = await runSql(ref, input.sql, { readOnly, maxRows: input.maxRows, timeoutMs: 30_000 });
    if (!readOnly) await audit({ action: "base.sql", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, sql: input.sql.slice(0, 2000), rowCount: r.rowCount } });
    return json({ ...r, readOnly });
  } catch (e) {
    throw E.bad((e as Error).message.slice(0, 1000));
  }
});
