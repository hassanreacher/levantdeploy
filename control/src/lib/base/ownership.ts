import { db } from "@/lib/db";
import { baseEvent } from "./events";
import { readSettings } from "./settings";

/**
 * One-time ownership fix for projects created before `runSql` switched from supabase_admin to postgres
 * (docs/requests/compat.md, fix 4): objects created through the SQL API in user schemas were owned by the superuser,
 * so apps / migration tools connecting as `postgres` hit "must be owner of …".
 *
 * Hands every supabase_admin-owned object in **user schemas** (public + schemas not managed by the image/platform) to
 * postgres: non-public schemas themselves, tables, partitioned tables, views, materialized views, foreign tables,
 * free-standing sequences (sequences owned by a column follow their table), functions/procedures/aggregates and types
 * (enum, domain, range, free-standing composite). Never touches auth / storage / realtime / extensions / vault / … and
 * never objects that belong to an extension. Idempotent; recorded in BaseProject.settings.maintenance.ownershipFixedAt.
 */
export const PLATFORM_SCHEMAS = [
  "pg_catalog", "information_schema", "pg_toast", "auth", "storage", "realtime", "_realtime", "extensions", "graphql", "graphql_public",
  "pgbouncer", "pgsodium", "pgsodium_masks", "vault", "net", "supabase_functions", "supabase_migrations", "_analytics", "_supavisor",
  "cron", "topology", "tiger", "tiger_data",
];

export function ownershipFixSql(from = "supabase_admin", to = "postgres"): string {
  const excluded = PLATFORM_SCHEMAS.map((s) => `'${s}'`).join(", ");
  const userSchemas = `n.nspname not in (${excluded}) and n.nspname not like 'pg\\_%'`;
  const notExt = (cls: string, oid: string) => `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;
  return `
do $levant$
declare r record; n_changed int := 0;
begin
  -- schemas (public keeps its image-defined owner)
  for r in select n.oid, n.nspname from pg_namespace n
           where ${userSchemas} and n.nspname <> 'public' and pg_get_userbyid(n.nspowner) = '${from}' and ${notExt("pg_namespace", "n.oid")} loop
    execute format('alter schema %I owner to ${to}', r.nspname); n_changed := n_changed + 1;
  end loop;
  -- relations (column-owned sequences follow their table)
  for r in select c.oid, n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where ${userSchemas} and c.relkind in ('r','p','v','m','f','S') and pg_get_userbyid(c.relowner) = '${from}'
             and ${notExt("pg_class", "c.oid")}
             and not (c.relkind = 'S' and exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a','i'))) loop
    execute format('alter %s %I.%I owner to ${to}',
      case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end,
      r.nspname, r.relname);
    n_changed := n_changed + 1;
  end loop;
  -- functions, procedures, aggregates
  for r in select p.oid::regprocedure as sig, p.prokind from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where ${userSchemas} and pg_get_userbyid(p.proowner) = '${from}' and ${notExt("pg_proc", "p.oid")} loop
    execute format('alter %s %s owner to ${to}', case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.sig);
    n_changed := n_changed + 1;
  end loop;
  -- types: enum, domain, range, free-standing composite (table row types follow their table)
  for r in select n.nspname, t.typname, t.typtype from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where ${userSchemas} and t.typtype in ('e','d','r','c') and pg_get_userbyid(t.typowner) = '${from}'
             and (t.typtype <> 'c' or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
             and ${notExt("pg_type", "t.oid")} loop
    execute format('alter %s %I.%I owner to ${to}', case r.typtype when 'd' then 'domain' else 'type' end, r.nspname, r.typname);
    n_changed := n_changed + 1;
  end loop;
  raise notice 'levant_ownership_changed=%', n_changed;
end $levant$;
select 'done';`;
}

export type Maintenance = { ownershipFixedAt?: string; ownershipChanged?: number };

/** Run the fix once for an ACTIVE project (no-op when already recorded, unless `force`). */
export async function ensureOwnershipFixed(ref: string, opts: { force?: boolean } = {}): Promise<{ ran: boolean; changed?: number }> {
  const p = await db.baseProject.findUnique({ where: { ref } });
  if (!p || p.status !== "ACTIVE") return { ran: false };
  const st = readSettings(p.settings);
  const m = (st.maintenance ?? {}) as Maintenance;
  if (m.ownershipFixedAt && !opts.force) return { ran: false };
  const { execIn } = await import("./compose");
  const r = await execIn(ref, "db", ["psql", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-At", "-U", "supabase_admin", "-h", "localhost", "-d", "postgres", "-f", "-"], {
    stdin: ownershipFixSql(),
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new Error(`ownership fix failed: ${r.err.trim().slice(-1000)}`);
  const changed = Number(/levant_ownership_changed=(\d+)/.exec(r.err)?.[1] ?? 0);
  const fresh = await db.baseProject.findUniqueOrThrow({ where: { ref } });
  const fs2 = readSettings(fresh.settings);
  await db.baseProject.update({
    where: { ref },
    data: { settings: { ...fs2, maintenance: { ...((fs2.maintenance ?? {}) as Maintenance), ownershipFixedAt: new Date().toISOString(), ownershipChanged: changed } } as object },
  });
  if (changed > 0) await baseEvent(p, "maintenance", `Ownership fix: ${changed} object(s) in user schemas handed from supabase_admin to postgres`, { level: "success" });
  return { ran: true, changed };
}

/** Mark a project as not needing the fix (new projects: runSql already creates objects as postgres). */
export function markOwnershipFixed(settings: Record<string, unknown>): Record<string, unknown> {
  return { ...settings, maintenance: { ...((settings.maintenance ?? {}) as Maintenance), ownershipFixedAt: new Date().toISOString(), ownershipChanged: 0 } };
}

/** Worker start: every ACTIVE project that hasn't been fixed yet (sequential, errors logged). */
export async function ownershipFixAll(log: (m: string) => void = () => {}) {
  const rows = await db.baseProject.findMany({ where: { status: "ACTIVE" }, select: { ref: true, settings: true } });
  for (const r of rows) {
    const m = (readSettings(r.settings).maintenance ?? {}) as Maintenance;
    if (m.ownershipFixedAt) continue;
    try {
      const res = await ensureOwnershipFixed(r.ref);
      if (res.ran) log(`ownership fix ${r.ref}: ${res.changed} object(s)`);
    } catch (e) {
      log(`ownership fix ${r.ref} failed: ${(e as Error).message}`);
    }
  }
}

