import { z } from "zod/v4";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decryptString } from "@/lib/crypto";
import { projectHost, deploymentHost } from "@/lib/deployments";
import { aiTeamAccess, ToolError } from "../permissions";
import { checkDomainDns, platformAddresses } from "../adapters";
import { buildDiagnosis } from "../diagnose";
import { formatLines, logSlice } from "../log-tools";
import { readRepoPath } from "../repo-files";
import { defineTool, deploymentArg, deploymentBrief, HOSTNAME, mask, projectArg, resolveDeployment, resolveProject } from "./shared";

export const listProjects = defineTool({
  name: "list_projects",
  description:
    "List the team's projects with their latest deployment status and production URL. Call this first when the user asks about 'my projects' or names a project you don't know the slug of.",
  schema: z.object({}),
  minRole: "VIEWER",
  scope: "projects:read",
  approval: false,
  summarize: () => "List projects",
  async run(_input, ctx) {
    await aiTeamAccess(ctx.actor, ctx.teamId, "VIEWER", "projects:read");
    const projects = await db.project.findMany({
      where: { teamId: ctx.teamId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { deployments: { orderBy: { number: "desc" }, take: 1 }, _count: { select: { domains: true } } },
    });
    return {
      projects: projects.map((p) => ({
        slug: p.slug,
        name: p.name,
        framework: p.framework,
        sourceType: p.sourceType,
        kind: p.kind,
        productionUrl: `${process.env.PLATFORM_SCHEME || "http"}://${projectHost(p.slug)}`,
        domains: p._count.domains,
        latestDeployment: p.deployments[0] ? deploymentBrief(p.deployments[0]) : null,
      })),
    };
  },
});

export const getProject = defineTool({
  name: "get_project",
  description:
    "Get a project's configuration: source, build settings, runtime settings (port, healthcheck, replicas, limits), domains and environment variable KEYS (never values). Only if the user explicitly asks to see env values and is an admin, pass reveal_env_values='masked' (or 'plain' when they insist; secret vars stay masked).",
  schema: z.object({
    project: projectArg,
    reveal_env_values: z.enum(["none", "masked", "plain"]).optional().describe("Default 'none'. Requires the admin role."),
  }),
  minRole: (i) => (i.reveal_env_values && i.reveal_env_values !== "none" ? "ADMIN" : "VIEWER"),
  scope: (i) => (i.reveal_env_values && i.reveal_env_values !== "none" ? "env:read" : "projects:read"),
  approval: false,
  summarize: (i) => `Read project settings${i.project ? ` of ${i.project}` : ""}${i.reveal_env_values && i.reveal_env_values !== "none" ? ` (${i.reveal_env_values} env values)` : ""}`,
  async run(input, ctx) {
    const reveal = input.reveal_env_values ?? "none";
    const { project: p, team } = await resolveProject(ctx, input.project, reveal === "none" ? "VIEWER" : "ADMIN", reveal === "none" ? "projects:read" : "env:read");
    const [domains, envs, dbs, volumes, crons] = await Promise.all([
      db.domain.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } }),
      db.envVar.findMany({ where: { projectId: p.id }, orderBy: [{ key: "asc" }, { createdAt: "asc" }] }),
      db.database.findMany({ where: { projectId: p.id }, select: { name: true, engine: true, version: true, status: true, internalHost: true, port: true } }),
      db.volume.findMany({ where: { projectId: p.id }, select: { name: true, mountPath: true } }),
      db.cronJob.count({ where: { projectId: p.id } }),
    ]);
    if (reveal !== "none")
      await audit({ action: "ai.env.reveal", teamId: team.id, userId: ctx.actor.userId, targetType: "project", targetId: p.id, meta: { mode: reveal, conversationId: ctx.conversationId } });
    return {
      project: {
        id: p.id,
        slug: p.slug,
        name: p.name,
        framework: p.framework,
        kind: p.kind,
        sourceType: p.sourceType,
        repo: p.githubRepoFullName ?? p.gitUrl ?? p.image ?? null,
        productionBranch: p.productionBranch,
        rootDirectory: p.rootDirectory,
        buildSettings: p.buildSettings,
        runtime: {
          port: p.port,
          healthcheckPath: p.healthcheckPath,
          replicas: p.replicas,
          cpuLimit: p.cpuLimit,
          memoryLimitMb: p.memoryLimitMb,
          restartPolicy: p.restartPolicy,
          runtimeSettings: p.runtimeSettings,
        },
        autoDeploy: p.autoDeploy,
        previewDeployments: p.previewDeployments,
        productionUrl: `${process.env.PLATFORM_SCHEME || "http"}://${projectHost(p.slug)}`,
      },
      domains: domains.map((d) => ({ hostname: d.hostname, kind: d.kind, status: d.status, isPrimary: d.isPrimary, redirectTo: d.redirectTo, gitBranch: d.gitBranch, lastError: d.lastError })),
      env: envs.map((e) => {
        const base = { key: e.key, targets: e.targets, isSecret: e.isSecret, branch: e.branch };
        if (reveal === "none") return base;
        const v = decryptString(e.valueEnc) ?? "";
        return { ...base, value: reveal === "plain" && !e.isSecret ? v : mask(v) };
      }),
      databases: dbs,
      volumes,
      cronJobs: crons,
    };
  },
});

export const listDeployments = defineTool({
  name: "list_deployments",
  description: "List a project's recent deployments (newest first) with status, target, commit and error. Use it to find the failing or last good deployment.",
  schema: z.object({
    project: projectArg,
    limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
    status: z.enum(["QUEUED", "BUILDING", "DEPLOYING", "READY", "ERROR", "CANCELED", "SUPERSEDED"]).optional(),
    target: z.enum(["PRODUCTION", "PREVIEW"]).optional(),
  }),
  minRole: "VIEWER",
  scope: "deployments:read",
  approval: false,
  summarize: (i) => `List deployments${i.status ? ` (${i.status.toLowerCase()})` : ""}`,
  async run(input, ctx) {
    const { project } = await resolveProject(ctx, input.project, "VIEWER", "deployments:read");
    const rows = await db.deployment.findMany({
      where: { projectId: project.id, ...(input.status ? { status: input.status } : {}), ...(input.target ? { target: input.target } : {}) },
      orderBy: { number: "desc" },
      take: input.limit ?? 10,
    });
    return { project: project.slug, deployments: rows.map(deploymentBrief) };
  },
});

export const getDeployment = defineTool({
  name: "get_deployment",
  description: "Get one deployment's details and status timeline (queued → building → deploying → ready/error).",
  schema: z.object({ deployment: deploymentArg, project: projectArg }),
  minRole: "VIEWER",
  scope: "deployments:read",
  approval: false,
  summarize: (i) => `Inspect deployment ${i.deployment ?? "latest"}`,
  async run(input, ctx) {
    const { deployment: d, project } = await resolveDeployment(ctx, input.deployment, input.project, "VIEWER", "deployments:read");
    const events = await db.deploymentEvent.findMany({ where: { deploymentId: d.id }, orderBy: { createdAt: "asc" }, take: 40 });
    return {
      project: project.slug,
      deployment: { ...deploymentBrief(d), imageTag: d.imageTag, framework: d.framework, containers: d.containerIds, meta: d.meta },
      timeline: events.map((e) => ({ from: e.fromStatus, status: e.status, message: e.message, at: e.createdAt.toISOString() })),
    };
  },
});

const logSchema = z.object({
  deployment: deploymentArg,
  project: projectArg,
  tail: z.number().int().min(1).max(500).optional().describe("Number of last lines (default 120)"),
  search: z.string().min(1).max(200).optional().describe("Case-insensitive regex/substring; returns matching lines with context instead of the tail"),
  context: z.number().int().min(0).max(5).optional().describe("Lines of context around search matches (default 1)"),
});

function logTool(name: "get_build_logs" | "get_runtime_logs", stream: "BUILD" | "RUNTIME") {
  return defineTool({
    name,
    description:
      stream === "BUILD"
        ? "Read a deployment's build log (clone, install, docker build). Use tail for the end of the log or search to grep for errors."
        : "Read a deployment's runtime (container stdout/stderr) log. Use it when a deployment built fine but crashes, fails its health check, or misbehaves.",
    schema: logSchema,
    minRole: "VIEWER",
    scope: "logs:read",
    approval: false,
    summarize: (i) => `${stream === "BUILD" ? "Read build logs" : "Read runtime logs"}${i.search ? ` matching "${i.search}"` : ` (last ${i.tail ?? 120} lines)`}`,
    async run(input, ctx) {
      const { deployment: d } = await resolveDeployment(ctx, input.deployment, input.project, "VIEWER", "logs:read");
      const s = await logSlice(d.id, stream, { tail: input.tail, search: input.search, context: input.context });
      return `deployment #${d.number} (${d.status}) ${stream.toLowerCase()} log — ${s.lines.length} line(s) shown of ${s.totalScanned} scanned${s.truncated ? ", truncated" : ""}, source=${s.source}${s.ended ? "" : ", still streaming"}\n${formatLines(s) || "(empty)"}`;
    },
  });
}
export const getBuildLogs = logTool("get_build_logs", "BUILD");
export const getRuntimeLogs = logTool("get_runtime_logs", "RUNTIME");

export const getMetrics = defineTool({
  name: "get_metrics",
  description: "Summarise a project's container metrics (CPU, memory vs limit, network, requests/errors) over the last N minutes. Use for performance, memory or crash-loop questions.",
  schema: z.object({ project: projectArg, minutes: z.number().int().min(5).max(1440).optional().describe("Window, default 60") }),
  minRole: "VIEWER",
  scope: "projects:read",
  approval: false,
  summarize: (i) => `Read metrics (last ${i.minutes ?? 60} min)`,
  async run(input, ctx) {
    const { project } = await resolveProject(ctx, input.project, "VIEWER", "projects:read");
    const minutes = input.minutes ?? 60;
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await db.metricSample.findMany({ where: { projectId: project.id, bucket: { gte: since } }, orderBy: { bucket: "asc" }, take: 20_000 });
    if (!rows.length) return { project: project.slug, minutes, samples: 0, note: "No metrics recorded in this window (the project may not be running, or metrics sampling is not enabled)." };
    const byDep = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.deploymentId ?? "unknown";
      byDep.set(k, [...(byDep.get(k) ?? []), r]);
    }
    const mb = (b: number) => Math.round(b / 1024 / 1024);
    const stat = (xs: number[]) => ({ avg: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, max: Math.round(Math.max(...xs) * 10) / 10 });
    return {
      project: project.slug,
      minutes,
      samples: rows.length,
      deployments: [...byDep.entries()].map(([id, rs]) => ({
        deploymentId: id,
        cpuPercent: stat(rs.map((r) => r.cpuPercent)),
        memoryMb: stat(rs.map((r) => mb(r.memoryBytes))),
        memoryLimitMb: rs.at(-1)?.memoryLimitBytes ? mb(rs.at(-1)!.memoryLimitBytes!) : null,
        netRxMb: mb(rs.reduce((a, r) => a + r.netRxBytes, 0)),
        netTxMb: mb(rs.reduce((a, r) => a + r.netTxBytes, 0)),
        requests: rs.reduce((a, r) => a + (r.requests ?? 0), 0),
        errors: rs.reduce((a, r) => a + (r.errors ?? 0), 0),
        from: rs[0]!.bucket.toISOString(),
        to: rs.at(-1)!.bucket.toISOString(),
      })),
    };
  },
});

export const diagnoseDeployment = defineTool({
  name: "diagnose_deployment",
  description:
    "Collect everything needed to explain a failed or unhealthy deployment in one call: status timeline, error step/message, build + runtime log tails, error lines, detected failure signals with suggestions, settings, env keys and the last good deployment. Call this first when the user asks why a deployment failed.",
  schema: z.object({ deployment: deploymentArg, project: projectArg }),
  minRole: "VIEWER",
  scope: "logs:read",
  approval: false,
  summarize: (i) => `Diagnose deployment ${i.deployment ?? "latest"}`,
  async run(input, ctx) {
    const { deployment, project } = await resolveDeployment(ctx, input.deployment, input.project, "VIEWER", "logs:read");
    return buildDiagnosis(deployment, project);
  },
});

export const checkDomainDnsTool = defineTool({
  name: "check_domain_dns",
  description: "Look up the live DNS records (A, AAAA, CNAME, TXT and the _levant-verify TXT) of a hostname and compare them with what LevantDeploy expects. Use when a custom domain is pending, failing or not serving.",
  schema: z.object({ hostname: z.string().min(3).max(253).describe("e.g. shop.example.com"), project: projectArg }),
  minRole: "VIEWER",
  scope: "domains:read",
  approval: false,
  summarize: (i) => `Check DNS of ${i.hostname}`,
  async run(input, ctx) {
    const hostname = input.hostname.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME.test(hostname)) throw new ToolError("INVALID", `${input.hostname} is not a valid hostname`);
    await aiTeamAccess(ctx.actor, ctx.teamId, "VIEWER", "domains:read");
    const row = await db.domain.findFirst({ where: { hostname, project: { teamId: ctx.teamId } }, include: { project: { select: { slug: true } } } });
    let projectSlug = row?.project.slug;
    if (!projectSlug && (input.project ?? ctx.projectId)) projectSlug = (await resolveProject(ctx, input.project, "VIEWER", "domains:read")).project.slug;
    const res = await checkDomainDns(hostname, { projectSlug, verifyToken: row?.verifyToken ?? null });
    return {
      domain: row ? { hostname: row.hostname, project: row.project.slug, status: row.status, certStatus: row.certStatus, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError } : null,
      dns: res.supported ? res.result : null,
      note: res.supported ? undefined : res.reason,
    };
  },
});

export const explainDnsSetup = defineTool({
  name: "explain_dns_setup",
  description: "Produce the exact DNS records the user must create at their DNS provider to point a hostname (apex or subdomain) at a project, including the verification TXT record.",
  schema: z.object({ hostname: z.string().min(3).max(253), project: projectArg }),
  minRole: "VIEWER",
  scope: "domains:read",
  approval: false,
  summarize: (i) => `Explain DNS setup for ${i.hostname}`,
  async run(input, ctx) {
    const hostname = input.hostname.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME.test(hostname)) throw new ToolError("INVALID", `${input.hostname} is not a valid hostname`);
    const { project } = await resolveProject(ctx, input.project, "VIEWER", "domains:read");
    const row = await db.domain.findFirst({ where: { hostname, projectId: project.id } });
    const ips = await platformAddresses();
    const labels = hostname.split(".");
    const isApex = labels.length === 2;
    const target = projectHost(project.slug);
    const records: { type: string; name: string; value: string; note?: string }[] = [];
    if (isApex) {
      if (ips.length) for (const ip of ips) records.push({ type: "A", name: "@", value: ip });
      else records.push({ type: "A", name: "@", value: "<your server's public IPv4>", note: "The server IP could not be detected automatically." });
      records.push({ type: "CNAME", name: "www", value: hostname, note: "optional — then add www as a domain redirecting to the apex" });
    } else {
      records.push({ type: "CNAME", name: labels[0]!, value: target, note: ips.length ? `or an A record to ${ips.join(", ")}` : undefined });
    }
    records.push({ type: "TXT", name: `_levant-verify${isApex ? "" : `.${labels.slice(0, -2).join(".")}`}`, value: row?.verifyToken ?? "<shown after you add the domain>" });
    return {
      hostname,
      project: project.slug,
      apex: isApex,
      attached: !!row,
      records,
      steps: [
        row ? "The domain is already attached to the project." : "Add the domain to the project (add_domain or Domains tab).",
        "Create the records above at your DNS provider (disable any proxy/CDN orange-cloud until the certificate is issued).",
        "Wait for DNS to propagate (usually minutes, up to 48 h); LevantDeploy verifies automatically and issues an HTTPS certificate on the first request.",
      ],
      previewHostExample: deploymentHost(project.slug, "abc123xyz"),
    };
  },
});

export const readRepoFile = defineTool({
  name: "read_repo_file",
  description:
    "Read a text file (or list a directory) from the source snapshot of a deployment (git checkout or uploaded folder). Use to inspect package.json, Dockerfile, config files when diagnosing. Max ~96 KB per file. Paths are relative to the repository root.",
  schema: z.object({ path: z.string().max(500).describe('Repo-relative path, e.g. "package.json" or "src/" ("" or "." lists the root)'), deployment: deploymentArg, project: projectArg }),
  minRole: "VIEWER",
  scope: "projects:read",
  approval: false,
  summarize: (i) => `Read ${i.path || "."}`,
  async run(input, ctx) {
    const { deployment } = await resolveDeployment(ctx, input.deployment, input.project, "VIEWER", "projects:read");
    return readRepoPath(deployment.id, input.path);
  },
});
