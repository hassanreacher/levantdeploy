import type { BaseStatus } from "@prisma/client";
import { appUrl } from "@/lib/env";
import { db } from "@/lib/db";
import { parseBaseHost } from "./config";

/** Branded pages for Base hosts (served by control at /api/internal/base/page, studio-auth, studio-sso). */
export type BasePageKind = "paused" | "provisioning" | "unavailable" | "error" | "not-found" | "deleting" | "studio-login" | "studio-starting" | "studio-denied";

const COPY: Record<BasePageKind, { status: number; title: string; body: string; refresh?: boolean }> = {
  paused: { status: 503, title: "Project paused", body: "This backend project is paused. Its owner can restore it from the dashboard." },
  provisioning: { status: 503, title: "Project is starting", body: "This backend project is being set up or resumed. This page refreshes automatically.", refresh: true },
  unavailable: { status: 503, title: "Project is starting", body: "The backend is not responding right now — it may be starting or restarting. Retrying shortly.", refresh: true },
  error: { status: 502, title: "Project unavailable", body: "This backend project failed to start. Its owner can find the details in the dashboard." },
  "not-found": { status: 404, title: "Project not found", body: "There is no backend project at this address." },
  deleting: { status: 410, title: "Project deleted", body: "This backend project has been deleted." },
  "studio-login": { status: 401, title: "Open Studio from the dashboard", body: "Studio is only available to team members. Open it from the project page in the dashboard." },
  "studio-starting": { status: 503, title: "Studio is starting", body: "Studio is being started for this project. This page refreshes automatically.", refresh: true },
  "studio-denied": { status: 403, title: "Link expired", body: "This sign-in link is invalid or has already been used. Open Studio again from the dashboard." },
};

export function kindForStatus(s: BaseStatus | null, state?: string | null): BasePageKind {
  if (!s) return "not-found";
  switch (s) {
    case "PAUSED":
    case "PAUSING":
      return "paused";
    case "PROVISIONING":
      return "provisioning";
    case "ERROR":
      return "error";
    case "DELETING":
      return "deleting";
    default:
      return state === "unavailable" ? "unavailable" : "unavailable";
  }
}

export async function pageKindForBaseHost(host: string, state?: string | null): Promise<BasePageKind> {
  const h = parseBaseHost(host);
  if (!h) return "not-found";
  const p = await db.baseProject.findUnique({ where: { ref: h.ref }, select: { status: true } });
  return kindForStatus(p?.status ?? null, state);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderBasePage(kind: BasePageKind, host: string): { status: number; html: string } {
  const c = COPY[kind];
  const dash = appUrl();
  const title = kind === "paused" ? "Project paused — restore it from the dashboard" : c.title;
  const top = c.refresh ? `<div class="spin" aria-hidden="true"></div>` : `<div class="code">${c.status}</div>`;
  const cta = kind === "paused" || kind === "studio-login" || kind === "studio-denied" || kind === "error"
    ? `<a class="btn" href="${esc(dash)}">Open dashboard</a>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title)} · LevantBase</title>${c.refresh ? `<meta http-equiv="refresh" content="5">` : ""}
<meta name="robots" content="noindex">
<style>
:root{color-scheme:dark light;--bg:#0a0a0a;--fg:#ededed;--muted:#a1a1a1;--border:#262626;--accent:#3b82f6}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#111;--muted:#666;--border:#e5e5e5}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;
background-image:radial-gradient(var(--border) 1px,transparent 1px);background-size:24px 24px}
.card{max-width:460px;width:100%;border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:32px;text-align:center}
.code{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.08em;margin-bottom:16px}
h1{font-size:22px;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}
p{color:var(--muted);margin:0 0 20px}
.host{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:6px 10px;display:inline-block;word-break:break-all}
.btn{display:inline-block;margin:0 0 18px;height:36px;line-height:36px;padding:0 16px;border-radius:6px;background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600}
.brand{margin-top:24px;font-size:12px;color:var(--muted)}.brand b{color:var(--fg)}
.spin{width:22px;height:22px;margin:0 auto 18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><main class="card">${top}<h1>${esc(title)}</h1><p>${esc(c.body)}</p>${cta ? `<div>${cta}</div>` : ""}<div class="host">${esc(host)}</div>
<div class="brand">Powered by <b>LevantBase</b> · LevantDeploy</div></main></body></html>`;
  return { status: c.status, html };
}

export function basePageResponse(kind: BasePageKind, host: string): Response {
  const { status, html } = renderBasePage(kind, host);
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...(status === 503 ? { "retry-after": "5" } : {}) },
  });
}
