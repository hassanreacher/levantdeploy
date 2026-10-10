import { appUrl } from "@/lib/env";

/** Branded pages served on preview-{id}.{PLATFORM_DOMAIN} by the gate (builder-core). Self-contained HTML. */
export type PreviewPageKind = "login" | "starting" | "denied" | "expired" | "not-found" | "error";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const COPY: Record<PreviewPageKind, { status: number; title: string; body: string; refresh?: number }> = {
  login: { status: 401, title: "Sign in to view this preview", body: "This is a private preview of an app being built on LevantDeploy. Open it from the Builder (you need to be a member of the team), or ask for a share link." },
  starting: { status: 503, title: "Starting the preview…", body: "The development server is waking up. This page refreshes automatically — usually 10–30 seconds.", refresh: 3 },
  denied: { status: 403, title: "This link is no longer valid", body: "Preview links expire after a few minutes. Open the preview again from the Builder." },
  expired: { status: 410, title: "This share link has expired", body: "Ask the app's owner for a new share link." },
  "not-found": { status: 404, title: "Preview not found", body: "This app doesn't exist (anymore)." },
  error: { status: 502, title: "The preview couldn't start", body: "Open the Builder to see what went wrong, or ask the AI to fix it." },
};

export function previewPage(kind: PreviewPageKind, opts: { detail?: string | null } = {}): Response {
  const c = COPY[kind];
  const dash = appUrl("/");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${c.refresh ? `<meta http-equiv="refresh" content="${c.refresh}">` : ""}<title>${esc(c.title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0a0b;color:#ededed}
.card{max-width:440px;margin:24px;padding:32px;border:1px solid #27272a;border-radius:14px;background:#111113;text-align:center}
h1{font-size:20px;margin:16px 0 8px;letter-spacing:-.01em}p{margin:0;color:#a1a1aa}a{color:#818cf8}.dot{width:40px;height:40px;margin:auto;border-radius:12px;background:linear-gradient(135deg,#6366f1,#22d3ee)}
.spin{width:22px;height:22px;margin:18px auto 0;border:3px solid #3f3f46;border-top-color:#818cf8;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
pre{margin-top:16px;text-align:left;white-space:pre-wrap;font-size:12px;color:#fca5a5;max-height:200px;overflow:auto}
@media (prefers-color-scheme:light){body{background:#fafafa;color:#09090b}.card{background:#fff;border-color:#e4e4e7}p{color:#52525b}}</style></head>
<body><div class="card"><div class="dot"></div><h1>${esc(c.title)}</h1><p>${esc(c.body)}</p>${kind === "starting" ? '<div class="spin"></div>' : ""}${opts.detail ? `<pre>${esc(opts.detail.slice(0, 1500))}</pre>` : ""}<p style="margin-top:18px;font-size:13px"><a href="${esc(dash)}">LevantDeploy</a></p></div></body></html>`;
  return new Response(html, { status: c.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(c.refresh ? { "retry-after": String(c.refresh) } : {}) } });
}
