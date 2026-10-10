import "server-only";
import type { EnvTarget } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createEnv } from "@/lib/dashboard/env-api";
import { E, type Actor } from "@/lib/http";
import { baseKeys, connectionStrings, projectUrl } from "./adapters";
import { customDomainOf } from "./dto";
import { connectEnvVars, type ConnectEnvOptions } from "./shared";

/**
 * "Connect a Base project" → writes the Supabase-compatible env vars into a Deploy project
 * (overwrites existing keys for the chosen targets) using the env-vars lib. Audited.
 */
export async function connectBaseEnv(opts: {
  ref: string;
  projectId: string;
  teamId: string;
  actor: Actor;
  targets: EnvTarget[];
  options: ConnectEnvOptions;
}): Promise<{ keys: string[]; created: number; updated: number }> {
  const base = await db.baseProject.findUniqueOrThrow({ where: { ref: opts.ref } });
  const [keys, conn] = await Promise.all([baseKeys(opts.ref), connectionStrings(opts.ref).catch(() => null)]);
  const url = projectUrl(opts.ref, customDomainOf(base));
  // LevantDeploy apps reach Postgres through the pooler on the private network (base-{ref}:6543 transaction / :5432 session)
  const txUrl = conn?.pooler ?? null;
  const sessionUrl = conn?.poolerSession ?? null;
  if (opts.options.includeDatabaseUrl && !txUrl && !sessionUrl) throw E.bad("The connection pooler is not enabled for this project (plan)");
  const items = opts.targets.flatMap((target) =>
    connectEnvVars({ url, internalUrl: keys.internalUrl, anonKey: keys.anonKey, serviceRoleKey: keys.serviceRoleKey, poolerUrl: txUrl, directUrl: sessionUrl }, opts.options, target).map((v) => ({
      ...v,
      targets: [target],
      branch: null,
      comment: `LevantBase ${base.name} (${base.ref})`,
    })),
  );
  // one row per key when the value is the same for every target (keeps the env list tidy)
  const merged = new Map<string, (typeof items)[number]>();
  for (const i of items) {
    const k = `${i.key}\u0000${i.value}`;
    const cur = merged.get(k);
    if (cur) cur.targets = [...cur.targets, ...i.targets];
    else merged.set(k, { ...i, targets: [...i.targets] });
  }
  const r = await createEnv({ projectId: opts.projectId }, { items: [...merged.values()], targets: opts.targets, isSecret: false, branch: null, overwrite: true }, opts.actor.user.id);
  await audit({
    action: "base.connect_env",
    teamId: opts.teamId,
    actor: opts.actor,
    targetType: "project",
    targetId: opts.projectId,
    meta: { ref: opts.ref, keys: r.keys, targets: opts.targets },
  });
  // the "env changed → redeploy" banner keys off env.* audit rows with targetType "project"
  await audit({ action: "env.update", teamId: opts.teamId, actor: opts.actor, targetType: "project", targetId: opts.projectId, meta: { keys: r.keys, via: "base.connect" } });
  return r;
}
