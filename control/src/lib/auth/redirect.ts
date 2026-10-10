/** Only allow same-site relative paths as post-login redirects. */
export function safeNext(next?: string | null): string | null {
  if (!next || typeof next !== "string") return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (next.startsWith("/api/")) return null;
  return next.slice(0, 500);
}
