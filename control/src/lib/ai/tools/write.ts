import { z } from "zod/v4";
import type { EnvTarget, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { encryptString } from "@/lib/crypto";
import { createDeployment } from "@/lib/deployments";
import { getSetting } from "@/lib/settings";
import { ToolError } from "../permissions";
import { addDomain, buildAreaDockerfile, buildSupportsInlineDockerfile, createDatabase, restartDeployment, rollbackTo } from "../adapters";
import { templateDockerfile } from "../dockerfile";
import { readRepoPath, snapshotDir } from "../repo-files";
import { defineTool, deploymentArg, deploymentBrief, ENV_KEY, HOSTNAME, mask, projectArg, RESERVED_ENV, resolveDeployment, resolveProject, type ToolCtx } from "./shared";

const TARGETS = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"] as const;
const auditBase = (ctx: ToolCtx) => ({ userId: ctx.actor.userId, actor: ctx.actor.token ? { user: { id: ctx.actor.userId }, token: { id: ctx.actor.token.id } } : undefined });

const envKey = z
  .string()
  .min(1)
  .max(256)
  .refine((k) => ENV_KEY.test(k), "Use letters, digits and underscores; don't start with a digit")
  .refine((k) => !RESERVED_ENV.has(k.toUpperCase()), "This key is reserved by LevantDeploy (PORT is set from the runtime settings)");

export const setEnvVar = defineTool({
  name: "set_env_var",
  description:
    "Propose creating or updating an environment variable (the user must approve it in the UI before it is applied; it takes effect on the next deployment — propose a redeploy afterwards if needed). Never invent secret values: ask the user for them.",
  schema: z.object({
    project: projectArg,
    key: envKey,
    value: z.string().max(64 * 1024),
    targets: z.array(z.enum(TARGETS)).min(1).max(3).optional().describe("Default: all three"),
    is_secret: z.boolean().optional().describe("Hide the value in the dashboard after saving"),
    branch: z.string().max(200).optional().describe("Preview-only override for one git branch"),
  }),
  minRole: "MEMBER",
  scope: "env:write",
  approval: true,
  summarize: (i) => `Set ${i.key} on ${(i.targets ?? TARGETS).map((t) => t.toLowerCase()).join(" + ")}${i.branch ? ` (branch ${i.branch})` : ""}`,
  // never store/show the value; secrets are fully masked, others show the last 4 characters
  display: (i) => ({ ...i, value: i.is_secret ? "••••••••" : mask(i.value), valueLength: i.value.length }),
  async precheck(i, ctx) {
    await resolveProject(ctx, i.project, "MEMBER", "env:write");
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, "MEMBER", "env:write");
    const targets: EnvTarget[] = [...(i.targets ?? TARGETS)];
    const existing = await db.envVar.findMany({ where: { projectId: project.id, key: i.key, branch: i.branch ?? null } });
    const overlap = existing.filter((e) => e.targets.some((t) => targets.includes(t)));
    let id: string;
    let action: "env.create" | "env.update";
    if (overlap.length === 1) {
      const row = await db.envVar.update({ where: { id: overlap[0]!.id }, data: { valueEnc: encryptString(i.value), targets, ...(i.is_secret !== undefined ? { isSecret: i.is_secret } : {}) } });
      id = row.id;
      action = "env.update";
    } else {
      if (overlap.length > 1) {
        // Several rows cover these targets: narrow them so the new value wins without duplicates.
        for (const e of overlap) {
          const rest = e.targets.filter((t) => !targets.includes(t));
          if (rest.length) await db.envVar.update({ where: { id: e.id }, data: { targets: rest } });
          else await db.envVar.delete({ where: { id: e.id } });
        }
      }
      const row = await db.envVar.create({
        data: { projectId: project.id, key: i.key, valueEnc: encryptString(i.value), targets, isSecret: i.is_secret ?? false, branch: i.branch ?? null, createdById: ctx.actor.userId, comment: "Set by LevantDeploy Agent" },
      });
      id = row.id;
      action = "env.create";
    }
    await audit({ action, teamId: team.id, ...auditBase(ctx), targetType: "env_var", targetId: id, meta: { key: i.key, targets, via: "ai", conversationId: ctx.conversationId } });
    return { ok: true, key: i.key, targets, branch: i.branch ?? null, note: "Saved. Existing deployments keep their old environment until redeployed." };
  },
});

export const deleteEnvVar = defineTool({
  name: "delete_env_var",
  description: "Propose deleting an environment variable (destructive: the user must type the project slug to approve). Takes effect on the next deployment.",
  schema: z.object({
    project: projectArg,
    key: z.string().min(1).max(256),
    targets: z.array(z.enum(TARGETS)).min(1).max(3).optional().describe("Only remove it from these targets (default: all)"),
    branch: z.string().max(200).optional(),
  }),
  minRole: "MEMBER",
  scope: "env:write",
  approval: true,
  confirmText: async (i, ctx) => (await resolveProject(ctx, i.project, "MEMBER", "env:write")).project.slug,
  summarize: (i) => `Delete ${i.key}${i.targets ? ` from ${i.targets.map((t) => t.toLowerCase()).join(" + ")}` : ""}`,
  async precheck(i, ctx) {
    const { project } = await resolveProject(ctx, i.project, "MEMBER", "env:write");
    const n = await db.envVar.count({ where: { projectId: project.id, key: i.key, branch: i.branch ?? null } });
    if (!n) throw new ToolError("NOT_FOUND", `${i.key} is not set on ${project.slug}`);
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, "MEMBER", "env:write");
    const rows = await db.envVar.findMany({ where: { projectId: project.id, key: i.key, branch: i.branch ?? null } });
    if (!rows.length) throw new ToolError("NOT_FOUND", `${i.key} is not set on ${project.slug}`);
    let removed = 0;
    for (const r of rows) {
      const rest = i.targets ? r.targets.filter((t) => !i.targets!.includes(t)) : [];
      if (rest.length) await db.envVar.update({ where: { id: r.id }, data: { targets: rest } });
      else await db.envVar.delete({ where: { id: r.id } });
      removed++;
      await audit({ action: "env.delete", teamId: team.id, ...auditBase(ctx), targetType: "env_var", targetId: r.id, meta: { key: i.key, targets: i.targets ?? r.targets, via: "ai" } });
    }
    return { ok: true, key: i.key, rowsChanged: removed };
  },
});

const nullableStr = (max: number) => z.string().max(max).nullable().optional();

export const updateBuildSettings = defineTool({
  name: "update_build_settings",
  description:
    "Propose changing build settings (install/build/start commands, output directory, Dockerfile path, Node version, root directory, framework). Pass null to clear a field. Applies to the next build; propose a redeploy afterwards.",
  schema: z.object({
    project: projectArg,
    installCommand: nullableStr(500),
    buildCommand: nullableStr(500),
    startCommand: nullableStr(500),
    outputDirectory: nullableStr(300),
    dockerfilePath: nullableStr(300),
    nodeVersion: z.string().regex(/^\d{2}(\.\d+){0,2}$/, "e.g. 20 or 22.11").nullable().optional(),
    rootDirectory: z.string().max(300).regex(/^(?!\/)(?!.*\.\.)[\w./-]*$/, "relative path without ..").optional(),
    framework: nullableStr(60),
  }),
  minRole: "MEMBER",
  scope: "projects:write",
  approval: true,
  summarize: (i) => `Update build settings: ${Object.keys(i).filter((k) => k !== "project").join(", ") || "nothing"}`,
  async precheck(i, ctx) {
    await resolveProject(ctx, i.project, "MEMBER", "projects:write");
    if (Object.keys(i).filter((k) => k !== "project").length === 0) throw new ToolError("INVALID", "No settings to change");
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, "MEMBER", "projects:write");
    const { project: _p, rootDirectory, framework, ...bs } = i;
    const current = (project.buildSettings as Record<string, unknown>) ?? {};
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(bs)) {
      if (v === undefined) continue;
      if (v === null || v === "") delete next[k];
      else next[k] = v;
    }
    const data: Prisma.ProjectUpdateInput = { buildSettings: next as Prisma.InputJsonObject };
    if (rootDirectory !== undefined) data.rootDirectory = rootDirectory.replace(/^\.\/?/, "").replace(/\/$/, "");
    if (framework !== undefined) data.framework = framework || null;
    await db.project.update({ where: { id: project.id }, data });
    await audit({ action: "project.update", teamId: team.id, ...auditBase(ctx), targetType: "project", targetId: project.id, meta: { section: "build", changed: Object.keys(i).filter((k) => k !== "project"), via: "ai" } });
    return { ok: true, buildSettings: next, rootDirectory: data.rootDirectory ?? project.rootDirectory, framework: framework !== undefined ? framework : project.framework };
  },
});

export const updateRuntimeSettings = defineTool({
  name: "update_runtime_settings",
  description:
    "Propose changing runtime settings: container port, healthcheck path (null disables the HTTP check), replicas, memory limit (MB), CPU limit, restart policy. Applies on the next deployment (propose a redeploy).",
  schema: z.object({
    project: projectArg,
    port: z.number().int().min(1).max(65535).optional(),
    healthcheckPath: z.string().max(300).regex(/^\//, "must start with /").nullable().optional(),
    replicas: z.number().int().min(0).max(32).optional(),
    memoryLimitMb: z.number().int().min(64).max(65536).nullable().optional(),
    cpuLimit: z.number().min(0.1).max(64).nullable().optional(),
    restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).optional(),
  }),
  minRole: "MEMBER",
  scope: "projects:write",
  approval: true,
  summarize: (i) =>
    `Update runtime: ${Object.entries(i)
      .filter(([k]) => k !== "project")
      .map(([k, v]) => `${k}=${v === null ? "none" : v}`)
      .join(", ")}`,
  async precheck(i, ctx) {
    await resolveProject(ctx, i.project, "MEMBER", "projects:write");
    const limits = await getSetting("limits.defaults");
    if (i.replicas !== undefined && i.replicas > limits.maxReplicas) throw new ToolError("INVALID", `Replicas are limited to ${limits.maxReplicas} on this platform`);
    if (Object.keys(i).filter((k) => k !== "project").length === 0) throw new ToolError("INVALID", "No settings to change");
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, "MEMBER", "projects:write");
    const limits = await getSetting("limits.defaults");
    if (i.replicas !== undefined && i.replicas > limits.maxReplicas) throw new ToolError("INVALID", `Replicas are limited to ${limits.maxReplicas} on this platform`);
    const { project: _p, ...rest } = i;
    const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Prisma.ProjectUpdateInput;
    const updated = await db.project.update({ where: { id: project.id }, data });
    await audit({ action: "project.update", teamId: team.id, ...auditBase(ctx), targetType: "project", targetId: project.id, meta: { section: "runtime", changed: Object.keys(data), via: "ai" } });
    return { ok: true, port: updated.port, healthcheckPath: updated.healthcheckPath, replicas: updated.replicas, memoryLimitMb: updated.memoryLimitMb, cpuLimit: updated.cpuLimit, restartPolicy: updated.restartPolicy };
  },
});

export const redeploy = defineTool({
  name: "redeploy",
  description:
    "Propose a redeploy: queue a new build of the same source as an existing deployment (default: the latest one) so new env vars / settings take effect. Requires the user's approval.",
  schema: z.object({ project: projectArg, deployment: deploymentArg, target: z.enum(["PRODUCTION", "PREVIEW"]).optional().describe("Default: same target as the source deployment") }),
  minRole: "MEMBER",
  scope: "deployments:write",
  approval: true,
  summarize: (i) => `Redeploy ${i.deployment ?? "latest deployment"}${i.target ? ` to ${i.target.toLowerCase()}` : ""}`,
  async precheck(i, ctx) {
    await resolveDeployment(ctx, i.deployment, i.project, "MEMBER", "deployments:write");
  },
  async run(i, ctx) {
    const { deployment: src, project, team } = await resolveDeployment(ctx, i.deployment, i.project, "MEMBER", "deployments:write");
    if (project.pausedAt) throw new ToolError("CONFLICT", `${project.slug} is paused; resume it before deploying`);
    const d = await createDeployment({
      projectId: project.id,
      target: i.target ?? src.target,
      trigger: "REDEPLOY",
      createdById: ctx.actor.userId,
      source: { branch: src.branch, commitSha: src.commitSha, commitMessage: src.commitMessage, commitAuthor: src.commitAuthor, commitAuthorAvatar: src.commitAuthorAvatar, prNumber: src.prNumber, uploadId: src.uploadId, sourceDeploymentId: src.id },
      meta: { via: "ai", conversationId: ctx.conversationId },
    });
    await audit({ action: "deployment.create", teamId: team.id, ...auditBase(ctx), targetType: "deployment", targetId: d.id, meta: { number: d.number, redeployOf: src.number, via: "ai" } });
    return { ok: true, queued: deploymentBrief(d) };
  },
});

export const rollback = defineTool({
  name: "rollback",
  description:
    "Propose rolling production back to an earlier successful deployment (destructive: the user must type the project slug). Use when the current production deployment is broken and an earlier one worked.",
  schema: z.object({ project: projectArg, deployment: z.string().min(1).max(60).describe("The earlier READY/SUPERSEDED production deployment to restore (id, short id or #number)") }),
  minRole: "MEMBER",
  scope: "deployments:write",
  approval: true,
  confirmText: async (i, ctx) => (await resolveDeployment(ctx, i.deployment, i.project, "MEMBER", "deployments:write")).project.slug,
  summarize: (i) => `Roll production back to ${i.deployment}`,
  async precheck(i, ctx) {
    const { deployment: d } = await resolveDeployment(ctx, i.deployment, i.project, "MEMBER", "deployments:write");
    if (d.isCurrentProduction) throw new ToolError("CONFLICT", `#${d.number} is already the current production deployment`);
    if (!["READY", "SUPERSEDED"].includes(d.status)) throw new ToolError("CONFLICT", `#${d.number} is ${d.status}; only successful deployments can be restored`);
    if (d.target !== "PRODUCTION") throw new ToolError("CONFLICT", `#${d.number} is a preview deployment`);
  },
  async run(i, ctx) {
    const { deployment: d, project, team } = await resolveDeployment(ctx, i.deployment, i.project, "MEMBER", "deployments:write");
    const res = await rollbackTo(project, d, ctx.actor.userId);
    if (!res.supported) throw new ToolError("UNAVAILABLE", res.reason);
    await audit({ action: "deployment.rollback", teamId: team.id, ...auditBase(ctx), targetType: "deployment", targetId: d.id, meta: { number: d.number, via: "ai" } });
    return { ok: true, restored: d.number, via: res.via };
  },
});

export const restart = defineTool({
  name: "restart",
  description: "Propose restarting the running containers of a deployment (default: current production) without rebuilding. Use for stuck or crash-looping apps.",
  schema: z.object({ project: projectArg, deployment: deploymentArg }),
  minRole: "MEMBER",
  scope: "deployments:write",
  approval: true,
  summarize: (i) => `Restart ${i.deployment ?? "production"}`,
  async precheck(i, ctx) {
    await resolveDeployment(ctx, i.deployment ?? "production", i.project, "MEMBER", "deployments:write");
  },
  async run(i, ctx) {
    const { deployment: d, team } = await resolveDeployment(ctx, i.deployment ?? "production", i.project, "MEMBER", "deployments:write");
    const res = await restartDeployment(d);
    if (!res.supported) throw new ToolError("UNAVAILABLE", res.reason);
    await audit({ action: "deployment.restart", teamId: team.id, ...auditBase(ctx), targetType: "deployment", targetId: d.id, meta: { number: d.number, via: "ai" } });
    return { ok: true, deployment: d.number, via: res.via, result: res.result };
  },
});

export const addDomainTool = defineTool({
  name: "add_domain",
  description: "Propose attaching a custom domain to a project (admin only). After approval, explain the DNS records with explain_dns_setup.",
  schema: z.object({
    project: projectArg,
    hostname: z.string().min(3).max(253),
    redirect_to: z.string().max(253).optional().describe("Redirect this host to another attached host (e.g. www → apex)"),
    git_branch: z.string().max(200).optional().describe("Serve the latest preview of this branch instead of production"),
  }),
  minRole: "ADMIN",
  scope: "domains:write",
  approval: true,
  summarize: (i) => `Add domain ${i.hostname}${i.redirect_to ? ` → ${i.redirect_to}` : ""}`,
  async precheck(i, ctx) {
    await resolveProject(ctx, i.project, "ADMIN", "domains:write");
    const h = i.hostname.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME.test(h)) throw new ToolError("INVALID", `${i.hostname} is not a valid hostname`);
    const platform = (process.env.PLATFORM_DOMAIN || "").toLowerCase();
    if (platform && (h === platform || h.endsWith(`.${platform}`))) throw new ToolError("INVALID", `Hosts under ${platform} are assigned automatically`);
    if (await db.domain.findUnique({ where: { hostname: h } })) throw new ToolError("CONFLICT", `${h} is already attached to a project`);
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, "ADMIN", "domains:write");
    const hostname = i.hostname.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME.test(hostname)) throw new ToolError("INVALID", `${i.hostname} is not a valid hostname`);
    const res = await addDomain({ projectId: project.id, hostname, redirectTo: i.redirect_to ?? null, gitBranch: i.git_branch ?? null, userId: ctx.actor.userId });
    if (!res.supported) throw new ToolError("CONFLICT", res.reason);
    await audit({ action: "domain.add", teamId: team.id, ...auditBase(ctx), targetType: "domain", targetId: hostname, meta: { hostname, via: "ai" } });
    return { ok: true, via: res.via, domain: res.result };
  },
});

export const createDatabaseTool = defineTool({
  name: "create_database",
  description: "Propose provisioning a managed database add-on (Postgres, MySQL, Redis or MongoDB) for the project (admin only). Its connection URL is injected as env vars by the runtime.",
  schema: z.object({
    project: projectArg,
    engine: z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO"]),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes"),
    version: z.string().max(20).optional(),
  }),
  minRole: "ADMIN",
  scope: "projects:write",
  approval: true,
  summarize: (i) => `Create ${i.engine.toLowerCase()} database "${i.name}"`,
  async precheck(i, ctx) {
    const { team } = await resolveProject(ctx, i.project, "ADMIN", "projects:write");
    if (await db.database.findUnique({ where: { teamId_name: { teamId: team.id, name: i.name } } })) throw new ToolError("CONFLICT", `A database named ${i.name} already exists in this team`);
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, "ADMIN", "projects:write");
    const res = await createDatabase({ teamId: team.id, projectId: project.id, engine: i.engine, name: i.name, version: i.version, userId: ctx.actor.userId });
    if (!res.supported) throw new ToolError("UNAVAILABLE", res.reason);
    await audit({ action: "database.create", teamId: team.id, ...auditBase(ctx), targetType: "database", targetId: i.name, meta: { engine: i.engine, via: "ai" } });
    return { ok: true, via: res.via, result: res.result };
  },
});

export const generateDockerfile = defineTool({
  name: "generate_dockerfile",
  description:
    "Generate a Dockerfile for the project (from the build engine's templates when available, otherwise a conventional template using the source snapshot). Returns the text. With save=true it proposes storing it as the build-setting override `dockerfileInline` (requires approval).",
  schema: z.object({ project: projectArg, deployment: deploymentArg, save: z.boolean().optional(), dockerfile: z.string().max(20_000).optional().describe("When saving: the exact Dockerfile text to store (e.g. after your edits)") }),
  minRole: (i) => (i.save ? "MEMBER" : "VIEWER"),
  scope: (i) => (i.save ? "projects:write" : "projects:read"),
  approval: (i) => !!i.save,
  summarize: (i) => (i.save ? "Save Dockerfile as build override" : "Generate a Dockerfile"),
  display: (i) => ({ ...i, dockerfile: i.dockerfile ? `${i.dockerfile.split("\n").length} lines` : undefined }),
  async precheck(i, ctx) {
    await resolveProject(ctx, i.project, "MEMBER", "projects:write");
  },
  async run(i, ctx) {
    const { project, team } = await resolveProject(ctx, i.project, i.save ? "MEMBER" : "VIEWER", i.save ? "projects:write" : "projects:read");
    let text = i.dockerfile ?? null;
    let via = "provided";
    let stack: string | undefined;
    if (!text) {
      let files: string[] = [];
      let pkg: Record<string, unknown> | null = null;
      const latest = await db.deployment.findFirst({ where: { projectId: project.id }, orderBy: { number: "desc" } });
      const dep = i.deployment ? (await resolveDeployment(ctx, i.deployment, i.project, "VIEWER", "projects:read")).deployment : latest;
      if (dep) {
        try {
          const root = await readRepoPath(dep.id, project.rootDirectory || ".");
          if (root.kind === "dir") files = root.entries;
          const p = await readRepoPath(dep.id, `${project.rootDirectory ? `${project.rootDirectory}/` : ""}package.json`).catch(() => null);
          if (p?.kind === "file") pkg = JSON.parse(p.content) as Record<string, unknown>;
        } catch {
          /* no snapshot */
        }
      }
      const dir = dep ? snapshotDir(dep.id) : null;
      const fromBuild = await buildAreaDockerfile(project, dir ? (project.rootDirectory ? `${dir}/${project.rootDirectory}` : dir) : null);
      if (fromBuild) {
        text = fromBuild.dockerfile;
        via = fromBuild.via;
        stack = fromBuild.framework;
      } else {
        const t = templateDockerfile(project, { files, packageJson: pkg as never, nodeVersion: (project.buildSettings as { nodeVersion?: string })?.nodeVersion ?? null });
        text = t.dockerfile;
        stack = t.stack;
        via = "ai-template";
      }
    }
    if (!i.save) return { dockerfile: text, stack, via, hint: "Show it to the user; call again with save=true (and the final text in `dockerfile`) to store it as an override." };
    const bs = { ...((project.buildSettings as Record<string, unknown>) ?? {}), dockerfileInline: text };
    await db.project.update({ where: { id: project.id }, data: { buildSettings: bs as Prisma.InputJsonObject } });
    await audit({ action: "project.update", teamId: team.id, ...auditBase(ctx), targetType: "project", targetId: project.id, meta: { section: "build", changed: ["dockerfileInline"], via: "ai" } });
    const supported = await buildSupportsInlineDockerfile();
    return {
      ok: true,
      saved: "buildSettings.dockerfileInline",
      lines: text.split("\n").length,
      note: supported ? "The next build will use it." : "Saved. Note: this build engine version may not read dockerfileInline yet — committing it as ./Dockerfile in the repo always works.",
    };
  },
});
