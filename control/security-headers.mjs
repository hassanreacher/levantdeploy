// Content-Security-Policy of the dashboard — shared by next.config.mjs (all routes, computed at build time) and
// src/middleware.ts (builder-ui: AI Builder routes add `frame-src` for the live preview, computed at RUNTIME from
// PLATFORM_DOMAIN because the Docker image is built without knowing the platform domain).

/** @param {{ frameSrc?: string[] }} [opts] */
export function contentSecurityPolicy(opts = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // git area: the GitHub App manifest flow POSTs a form to github.com (or GITHUB_WEB_URL for GHES)
    `form-action 'self' ${process.env.GITHUB_WEB_URL || "https://github.com"}`,
    "frame-ancestors 'self'",
    ...(opts.frameSrc?.length ? [`frame-src 'self' ${opts.frameSrc.join(" ")}`] : []),
  ].join("; ");
}

/** builder-ui: origins of the live previews (preview-{id}.{domain}); http only outside production. */
export function builderPreviewFrameSrc(platformDomain) {
  const d = String(platformDomain || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!d) return [];
  // CSP host wildcards must be the left-most label (`preview-*.` is invalid) → *.{domain}
  const out = [`https://*.${d}`, `https://*.${d}:*`];
  if (process.env.NODE_ENV !== "production" || process.env.PLATFORM_SCHEME === "http") out.push(`http://*.${d}`, `http://*.${d}:*`);
  return out;
}
