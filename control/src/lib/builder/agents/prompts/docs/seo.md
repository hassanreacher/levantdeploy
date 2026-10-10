# SEO & metadata
- Root layout: `export const metadata: Metadata = { title: { default: "Brew & Co", template: "%s · Brew & Co" }, description: "…", openGraph: { title, description, type: "website" } };`
- Each page: `export const metadata = { title: "Menu", description: "…" }` (server components only).
- `<html lang="en">`; semantic HTML; descriptive link text; `app/robots.ts` / `app/sitemap.ts` optional for content sites.
- Performance: `next/image` with sizes for local images, `priority` on the hero image only; avoid huge client bundles (keep pages server components).
