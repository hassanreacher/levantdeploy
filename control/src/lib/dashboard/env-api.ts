import "server-only";
import { z } from "zod";
import type { EnvTarget, EnvVar, Prisma, TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { E } from "@/lib/http";
import { hasRole } from "@/lib/auth/roles";
import { decryptString, encryptString } from "@/lib/crypto";
import { ENV_TARGETS, MAX_ENV_VALUE, envKeyError, parseDotenv } from "./env-vars";

/** Shared logic for project env vars and shared env group vars (owner = { projectId } | { groupId }). */
export type EnvOwner = { projectId: string } | { groupId: string };

const target = z.enum(["PRODUCTION", "PREVIEW", "DEVELOPMENT"]);
const keyField = z.string().trim().superRefine((k, ctx) => {
  const err = envKeyError(k);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});
const branchField = z
  .string()
  .trim()
  .max(255)
  .nullish()
  .transform((b) => (b ? b : null));

export const envItemSchema = z.object({
  key: keyField,
  value: z.string().max(MAX_ENV_VALUE),
  targets: z.array(target).min(1).default(ENV_TARGETS),
  isSecret: z.boolean().default(false),
  branch: branchField,
  comment: z.string().max(500).nullish(),
});

export const envCreateSchema = z
  .object({
    items: z.array(envItemSchema).max(500).optional(),
    /** bulk paste: a .env file; `targets`, `isSecret`, `branch` apply to every line */
    dotenv: z.string().max(512 * 1024).optional(),
    targets: z.array(target).min(1).default(ENV_TARGETS),
    isSecret: z.boolean().default(false),
    branch: branchField,
    /** replace the value of existing vars with the same key/branch/target instead of failing with 409 */
    overwrite: z.boolean().default(false),
  })
  .refine((v) => v.items?.length || v.dotenv?.trim(), { message: "Provide items or a .env text", path: ["items"] });

export const envPatchSchema = z
  .object({ key: keyField, value: z.string().max(MAX_ENV_VALUE), targets: z.array(target).min(1), isSecret: z.boolean(), branch: branchField, comment: z.string().max(500).nullable() })
  .partial();

export type EnvItemView = {
  id: string;
  key: string;
  /** null when hidden (secret, or caller is a viewer) */
  value: string | null;
  isSecret: boolean;
  targets: EnvTarget[];
  branch: string | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { name: string; avatar: string | null } | null;
};

/** Values are only returned for non-secret vars to MEMBER+ (secrets need the reveal endpoint, ADMIN+). */
export function viewEnv(v: EnvVar & { createdBy?: { name: string; avatar: string | null } | null }, role: TeamRole, decryptAll = false): EnvItemView {
  const canSee = decryptAll ? (v.isSecret ? hasRole(role, "ADMIN") : hasRole(role, "MEMBER")) : !v.isSecret && hasRole(role, "MEMBER");
  return {
    id: v.id,
    key: v.key,
    value: canSee ? decryptString(v.valueEnc) : null,
    isSecret: v.isSecret,
    targets: v.targets,
    branch: v.branch,
    comment: v.comment,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    createdBy: v.createdBy ? { name: v.createdBy.name, avatar: v.createdBy.avatar } : null,
  };
}

const ownerWhere = (o: EnvOwner): Prisma.EnvVarWhereInput => ("projectId" in o ? { projectId: o.projectId } : { groupId: o.groupId });

export async function listEnv(o: EnvOwner) {
  return db.envVar.findMany({ where: ownerWhere(o), orderBy: [{ key: "asc" }, { createdAt: "asc" }], include: { createdBy: { select: { name: true, avatar: true } } } });
}

/** Create (or overwrite) many vars at once. Returns { created, updated, conflicts }. */
export async function createEnv(o: EnvOwner, input: z.infer<typeof envCreateSchema>, userId: string) {
  let items: z.infer<typeof envItemSchema>[] = input.items ?? [];
  if (input.dotenv?.trim()) {
    const parsed = parseDotenv(input.dotenv);
    if (!parsed.length) throw E.validation({ dotenv: "No KEY=value lines found" });
    const fields: Record<string, string> = {};
    for (const p of parsed) {
      const err = envKeyError(p.key);
      if (err) fields[`dotenv.${p.line}`] = `${p.key}: ${err}`;
    }
    if (Object.keys(fields).length) throw E.validation(fields, "Some keys are invalid");
    items = [...items, ...parsed.map((p) => ({ key: p.key, value: p.value, targets: input.targets, isSecret: input.isSecret, branch: input.branch, comment: null }))];
  }
  if ("groupId" in o && items.some((i) => i.branch)) throw E.validation({ branch: "Shared env groups can't have branch-specific values" });
  for (const i of items) if (i.branch && (i.targets.length !== 1 || i.targets[0] !== "PREVIEW")) i.targets = ["PREVIEW"];

  const existing = await db.envVar.findMany({ where: { ...ownerWhere(o), key: { in: items.map((i) => i.key) } } });
  const conflicts: string[] = [];
  const plan: { create?: (typeof items)[number]; update?: { id: string; item: (typeof items)[number] } }[] = [];
  for (const i of items) {
    const clash = existing.find((e) => e.key === i.key && (e.branch ?? null) === (i.branch ?? null) && e.targets.some((t) => i.targets.includes(t)));
    if (clash) {
      if (input.overwrite) plan.push({ update: { id: clash.id, item: i } });
      else conflicts.push(i.key);
    } else plan.push({ create: i });
  }
  if (conflicts.length && !input.overwrite) {
    throw E.conflict(`Already defined for the same environment: ${[...new Set(conflicts)].slice(0, 8).join(", ")}${conflicts.length > 8 ? "…" : ""}`);
  }
  let created = 0;
  let updated = 0;
  await db.$transaction(
    plan.map((p) => {
      if (p.update) {
        updated++;
        const i = p.update.item;
        return db.envVar.update({ where: { id: p.update.id }, data: { valueEnc: encryptString(i.value), isSecret: i.isSecret || undefined, comment: i.comment ?? undefined } });
      }
      created++;
      const i = p.create!;
      return db.envVar.create({
        data: { ...ownerWhere(o), key: i.key, valueEnc: encryptString(i.value), targets: i.targets, isSecret: i.isSecret, branch: i.branch, comment: i.comment ?? null, createdById: userId } as Prisma.EnvVarUncheckedCreateInput,
      });
    }),
  );
  return { created, updated, keys: [...new Set(items.map((i) => i.key))] };
}

export async function updateEnv(o: EnvOwner, id: string, input: z.infer<typeof envPatchSchema>) {
  const cur = await db.envVar.findFirst({ where: { id, ...ownerWhere(o) } });
  if (!cur) throw E.notFound("Environment variable not found");
  if (input.isSecret === false && cur.isSecret) throw E.bad("A secret can't be made visible again. Delete it and create a new variable.");
  const data: Prisma.EnvVarUpdateInput = {};
  if (input.key !== undefined) data.key = input.key;
  if (input.value !== undefined) data.valueEnc = encryptString(input.value);
  if (input.targets) data.targets = input.targets;
  if (input.isSecret) data.isSecret = true;
  if (input.comment !== undefined) data.comment = input.comment;
  if (input.branch !== undefined) {
    if ("groupId" in o && input.branch) throw E.validation({ branch: "Shared env groups can't have branch-specific values" });
    data.branch = input.branch;
    if (input.branch) data.targets = ["PREVIEW"];
  }
  const nextKey = input.key ?? cur.key;
  const nextBranch = input.branch !== undefined ? input.branch : cur.branch;
  const nextTargets = (data.targets as EnvTarget[] | undefined) ?? cur.targets;
  const clash = await db.envVar.findFirst({ where: { ...ownerWhere(o), key: nextKey, branch: nextBranch, NOT: { id }, targets: { hasSome: nextTargets } }, select: { id: true } });
  if (clash) throw E.conflict(`${nextKey} is already defined for one of these environments`);
  return db.envVar.update({ where: { id }, data });
}

/** Has any env var changed since the latest READY production deployment? (→ "Redeploy to apply" banner) */
export async function envChangedSinceDeploy(projectId: string) {
  const [lastEnv, lastLink, prod] = await Promise.all([
    db.envVar.findFirst({ where: { projectId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    db.projectSharedEnvGroup.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.deployment.findFirst({ where: { projectId, isCurrentProduction: true }, select: { id: true, createdAt: true } }),
  ]);
  const [groupVar, lastAudit] = await Promise.all([
    db.envVar.findFirst({ where: { group: { projects: { some: { projectId } } } }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    // deletions / unlinks leave no row behind → env audit entries are written with targetType "project"
    db.auditLog.findFirst({ where: { targetType: "project", targetId: projectId, action: { startsWith: "env." } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const changedAt = [lastEnv?.updatedAt, lastLink?.createdAt, groupVar?.updatedAt, lastAudit?.createdAt].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
  return { changed: !!(prod && changedAt && changedAt > prod.createdAt), changedAt: changedAt?.toISOString() ?? null, productionDeploymentId: prod?.id ?? null };
}
