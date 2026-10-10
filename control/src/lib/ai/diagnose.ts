import type { Deployment, Project } from "@prisma/client";
import { db } from "@/lib/db";
import { formatLines, logSlice } from "./log-tools";

/**
 * Structured failure summary for `diagnose_deployment` and the auto-diagnosis banner.
 * Pure heuristics over logs + settings; the model turns it into an explanation and a fix.
 */
export type Signal = { kind: string; detail: string; suggestion: string; line?: number };

export type Diagnosis = {
  deployment: { id: string; number: number; status: string; target: string; branch: string | null; commitSha: string | null; errorStep: string | null; errorMessage: string | null; createdAt: string; durationMs: number | null };
  timeline: { status: string; message: string | null; at: string }[];
  settings: { framework: string | null; kind: string; port: number; healthcheckPath: string | null; replicas: number; memoryLimitMb: number | null; rootDirectory: string; buildSettings: unknown };
  envKeys: string[];
  signals: Signal[];
  buildLogTail: string;
  runtimeLogTail: string;
  errorLines: string;
  lastReady: { id: string; number: number; commitSha: string | null; readyAt: string | null } | null;
};

type Rule = { re: RegExp; kind: string; detail: (m: RegExpExecArray) => string; suggestion: (m: RegExpExecArray, p: Project) => string };

const RULES: Rule[] = [
  {
    re: /(?:process\.env\.|[Ee]nv(?:ironment)? [Vv]ar(?:iable)?:?\s+)["'`]?([A-Z][A-Z0-9_]{2,})\b/,
    kind: "missing_env",
    detail: (m) => `The app references the environment variable ${m[1]}, which may be missing.`,
    suggestion: (m) => `Add ${m[1]} in Environment (set_env_var) and redeploy.`,
  },
  {
    re: /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b["'`]?\s+(?:is not defined|is not set|is missing|must be set|is required|is undefined|environment variable (?:is )?(?:missing|required|not set))/,
    kind: "missing_env",
    detail: (m) => `The app references the environment variable ${m[1]}, which is not set.`,
    suggestion: (m) => `Add ${m[1]} in Environment (set_env_var) and redeploy.`,
  },
  { re: /npm ERR! missing script: "?([\w:-]+)"?|Missing script: "?([\w:-]+)"?/i, kind: "missing_script", detail: (m) => `package.json has no "${m[1] ?? m[2]}" script.`, suggestion: (m) => `Add the "${m[1] ?? m[2]}" script or change the build/start command (update_build_settings).` },
  { re: /Cannot find module '([^']+)'|Module not found: (?:Error: )?Can't resolve '([^']+)'/i, kind: "missing_module", detail: (m) => `A module could not be resolved: ${m[1] ?? m[2]}.`, suggestion: () => "Check that the dependency is in package.json (not only devDependencies when installing with --omit=dev) and that import paths/casing are correct." },
  { re: /EADDRINUSE.*?:(\d+)/i, kind: "port_in_use", detail: (m) => `Port ${m[1]} is already in use inside the container.`, suggestion: () => "Make sure only one process listens on the port." },
  { re: /(?:listening|started|running|server)\s+(?:on|at)\s+(?:https?:\/\/)?(?:[\w.-]+|\[::\]|0\.0\.0\.0)?:?(?:port\s+)?(\d{2,5})/i, kind: "listen_port", detail: (m) => `The app says it listens on port ${m[1]}.`, suggestion: (m, p) => (Number(m[1]) !== p.port ? `Project port is ${p.port} but the app listens on ${m[1]}: update the port (update_runtime_settings) or make the app read $PORT.` : "") },
  { re: /\b(?:exit code|exited with code)\s*:?\s*137\b|OOMKilled|JavaScript heap out of memory|Killed$/im, kind: "out_of_memory", detail: () => "The process was killed for running out of memory.", suggestion: (_m, p) => `Raise the memory limit (currently ${p.memoryLimitMb ?? "default"} MB) with update_runtime_settings, or reduce build memory (NODE_OPTIONS=--max-old-space-size).` },
  { re: /health ?check.*(?:fail|timed? ?out)|unhealthy/i, kind: "healthcheck", detail: () => "The container did not pass its health check.", suggestion: (_m, p) => `Check the healthcheck path (${p.healthcheckPath ?? "none"}) and port (${p.port}); the app must answer 2xx/3xx there.` },
  { re: /failed to (?:read|solve).*dockerfile|Dockerfile: no such file|unable to prepare context/i, kind: "dockerfile", detail: () => "Docker could not find or parse the Dockerfile.", suggestion: () => "Check dockerfilePath / rootDirectory in the build settings, or generate a Dockerfile (generate_dockerfile)." },
  { re: /The engine "node" is incompatible|Unsupported engine|requires node(?:\.js)? (?:version )?([>=^~\d.]+)/i, kind: "node_version", detail: () => "The Node.js version doesn't match package.json engines.", suggestion: () => "Set nodeVersion in the build settings (update_build_settings) to a compatible major version." },
  { re: /ECONNREFUSED\s+([\d.:]+)|getaddrinfo ENOTFOUND ([\w.-]+)/i, kind: "connection", detail: (m) => `The app could not reach ${m[1] ?? m[2]}.`, suggestion: () => "Check database/service URLs in the environment variables; inside LevantDeploy use the internal host of the database add-on." },
  { re: /permission denied/i, kind: "permission", detail: () => "A file or socket permission error occurred.", suggestion: () => "Check file ownership in the image (USER directive) and that start scripts are executable." },
];

const ERRORISH = /\b(error|failed|failure|fatal|exception|panic|cannot|could not|not found|denied|refused|killed|exit code [1-9])/i;

export function detectSignals(text: string, project: Project): Signal[] {
  const out: Signal[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (!m) continue;
      const suggestion = r.suggestion(m, project);
      if (!suggestion) continue;
      const detail = r.detail(m);
      const key = `${r.kind}:${m[1] ?? detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = /^\s*(\d+) \|/.exec(line);
      out.push({ kind: r.kind, detail, suggestion, line: n ? Number(n[1]) : undefined });
    }
    if (out.length >= 8) break;
  }
  return out;
}

export async function buildDiagnosis(d: Deployment, project: Project): Promise<Diagnosis> {
  const [events, envs, lastReady, build, runtime, errs] = await Promise.all([
    db.deploymentEvent.findMany({ where: { deploymentId: d.id }, orderBy: { createdAt: "asc" }, take: 30 }),
    db.envVar.findMany({ where: { projectId: project.id }, select: { key: true }, distinct: ["key"], orderBy: { key: "asc" } }),
    db.deployment.findFirst({ where: { projectId: project.id, status: { in: ["READY", "SUPERSEDED"] }, number: { lt: d.number } }, orderBy: { number: "desc" } }),
    logSlice(d.id, "BUILD", { tail: 120 }),
    logSlice(d.id, "RUNTIME", { tail: 80 }),
    logSlice(d.id, "BUILD", { search: ERRORISH.source, context: 1, maxMatches: 40 }),
  ]);
  const buildText = formatLines(build);
  const runtimeText = formatLines(runtime);
  const errorText = formatLines(errs);
  const signals = detectSignals([d.errorMessage ?? "", errorText, buildText, runtimeText].join("\n"), project);
  if (d.errorStep === "HEALTHCHECK" && !signals.some((s) => s.kind === "healthcheck"))
    signals.unshift({ kind: "healthcheck", detail: "The deployment failed at the health check step.", suggestion: `Verify the app listens on port ${project.port} and answers on ${project.healthcheckPath ?? "/"}.` });
  return {
    deployment: {
      id: d.id,
      number: d.number,
      status: d.status,
      target: d.target,
      branch: d.branch,
      commitSha: d.commitSha,
      errorStep: d.errorStep,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt.toISOString(),
      durationMs: d.duration,
    },
    timeline: events.map((e) => ({ status: e.status, message: e.message, at: e.createdAt.toISOString() })),
    settings: {
      framework: project.framework,
      kind: project.kind,
      port: project.port,
      healthcheckPath: project.healthcheckPath,
      replicas: project.replicas,
      memoryLimitMb: project.memoryLimitMb,
      rootDirectory: project.rootDirectory,
      buildSettings: project.buildSettings,
    },
    envKeys: envs.map((e) => e.key),
    signals,
    buildLogTail: buildText || "(no build log lines)",
    runtimeLogTail: runtimeText || "(no runtime log lines)",
    errorLines: errorText,
    lastReady: lastReady ? { id: lastReady.id, number: lastReady.number, commitSha: lastReady.commitSha, readyAt: lastReady.readyAt?.toISOString() ?? null } : null,
  };
}

/** Plain-text summary when no model is available (auto-diagnosis fallback). */
export function heuristicSummary(dx: Diagnosis): string {
  const head = `Deployment #${dx.deployment.number} failed${dx.deployment.errorStep ? ` during ${dx.deployment.errorStep.toLowerCase()}` : ""}${dx.deployment.errorMessage ? `: ${dx.deployment.errorMessage.slice(0, 200)}` : "."}`;
  if (!dx.signals.length) return `${head} No known failure pattern was found in the logs; open the build log for details.`;
  return [head, ...dx.signals.slice(0, 3).map((s) => `- ${s.detail} ${s.suggestion}`)].join("\n");
}
