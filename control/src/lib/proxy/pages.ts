import type { Deployment } from "@prisma/client";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { resolveHost } from "./hosts";

/**
 * Branded pages Caddy shows for hosts without a live upstream (served by the control app at
 * /api/internal/pages/host?host=…&state=…). Self-contained HTML (inline CSS, no external assets).
 */

export type PageKind = "worker" | "not-found" | "building" | "starting" | "stopped" | "error" | "canceled" | "unavailable" | "no-production" | "domain-pending";

const COPY: Record<PageKind, { status: number; title: string; body: string; refresh?: boolean }> = {
  worker: { status: 404, title: "No HTTP endpoint", body: "This project runs a background worker — it is running, but it does not serve web traffic." },
  "not-found": { status: 404, title: "Deployment not found", body: "There is no deployment at this address. Check the URL, or the deployment may have been removed." },
  building: { status: 503, title: "Deployment is building", body: "This deployment is being built right now. This page refreshes automatically when it is ready.", refresh: true },
  starting: { status: 503, title: "Deployment is starting", body: "The containers are starting and being health-checked. This page refreshes automatically.", refresh: true },
  stopped: { status: 503, title: "Deployment is stopped", body: "This deployment is not running. Its owner can restart or promote it from the dashboard." },
  error: { status: 502, title: "Deployment failed", body: "This deployment failed to build or start. Its owner can find the logs in the dashboard." },
  canceled: { status: 404, title: "Deployment canceled", body: "This deployment was canceled before it went live." },
  unavailable: { status: 503, title: "Deployment is starting", body: "The application is not responding right now — it may be starting or restarting. Retrying shortly.", refresh: true },
  "no-production": { status: 404, title: "No production deployment yet", body: "This project exists but has nothing in production yet." },
  "domain-pending": { status: 404, title: "Domain not verified yet", body: "This domain was added to a project but its DNS records have not been verified yet." },
};

function kindForDeployment(d: Pick<Deployment, "status" | "stoppedAt">): PageKind {
  switch (d.status) {
    case "QUEUED":
    case "BUILDING":
      return "building";
    case "DEPLOYING":
      return "starting";
    case "ERROR":
      return "error";
    case "CANCELED":
      return "canceled";
    default:
      return d.stoppedAt ? "stopped" : "unavailable";
  }
}

export async function pageKindForHost(host: string, state?: string | null): Promise<PageKind> {
  const r = await resolveHost(host);
  if (r.kind !== "unknown" && r.kind !== "dashboard" && r.project.kind === "WORKER") return "worker";
  if (r.kind === "deployment") return kindForDeployment(r.deployment);
  if (r.kind === "branch") return r.deployment ? kindForDeployment(r.deployment) : "not-found";
  if (r.kind === "domain") {
    if (r.domain.status !== "ACTIVE") return "domain-pending";
    const target = r.domain.gitBranch
      ? await db.deployment.findFirst({ where: { projectId: r.project.id, branch: r.domain.gitBranch }, orderBy: { createdAt: "desc" } })
      : ((await db.deployment.findFirst({ where: { projectId: r.project.id, isCurrentProduction: true } })) ??
        (await db.deployment.findFirst({ where: { projectId: r.project.id, target: "PRODUCTION" }, orderBy: { createdAt: "desc" } })));
    if (!target) return "no-production";
    return kindForDeployment(target);
  }
  if (state === "unavailable" && r.kind !== "unknown") return "unavailable";
  return "not-found";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderHostPage(kind: PageKind, host: string): { status: number; html: string } {
  const c = COPY[kind];
  const spinner = c.refresh ? `<div class="spin" aria-hidden="true"></div>` : `<div class="code">${c.status}</div>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title)} · LevantDeploy</title>${c.refresh ? `<meta http-equiv="refresh" content="5">` : ""}
<meta name="robots" content="noindex">
<style>
:root{color-scheme:dark light;--bg:#0a0a0a;--fg:#ededed;--muted:#a1a1a1;--border:#262626;--accent:#3b82f6}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#111;--muted:#666;--border:#e5e5e5}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;
background-image:radial-gradient(var(--border) 1px,transparent 1px);background-size:24px 24px}
.card{max-width:440px;width:100%;border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:32px;text-align:center}
.code{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.08em;margin-bottom:16px}
h1{font-size:22px;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}
p{color:var(--muted);margin:0 0 20px}
.host{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:6px 10px;display:inline-block;word-break:break-all}
.brand{margin-top:24px;font-size:12px;color:var(--muted)}.brand a{color:var(--muted);text-decoration:none}
.brand b{color:var(--fg)}
.spin{width:22px;height:22px;margin:0 auto 18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><main class="card">${spinner}<h1>${esc(c.title)}</h1><p>${esc(c.body)}</p><div class="host">${esc(host)}</div>
<div class="brand">Powered by <a href="${esc(appUrl())}"><b>▲ LevantDeploy</b></a></div></main></body></html>`;
  return { status: c.status, html };
}

/** Password page for "password"-protected deployments (form posts to /__levant/auth on the same host). */
export function renderPasswordPage(host: string, next: string, error?: string): { html: string } {
  const page = renderHostPage("not-found", host).html;
  const body = `<main class="card"><div class="code">PROTECTED</div><h1>This deployment is password protected</h1>
<p>Enter the password to continue to <b>${esc(host)}</b>.</p>
<form method="post" action="/__levant/auth" style="display:flex;flex-direction:column;gap:10px;text-align:left">
<input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password"
 style="height:38px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--fg);padding:0 12px;font:inherit">
${error ? `<div style="color:#ff5555;font-size:13px">${esc(error)}</div>` : ""}
<button type="submit" style="height:38px;border-radius:6px;border:0;background:var(--fg);color:var(--bg);font:600 14px/1 inherit;cursor:pointer">Continue</button>
</form><div class="brand">Powered by <b>▲ LevantDeploy</b></div></main>`;
  return { html: page.replace(/<title>[^<]*<\/title>/, "<title>Password required · LevantDeploy</title>").replace(/<main class="card">[\s\S]*<\/main>/, body) };
}
