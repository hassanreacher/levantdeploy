## Stack & conventions (binding)
The app is **Next.js 15 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS 3 + shadcn/ui + lucide-react**, backed (optionally) by a
LevantBase backend used through **@supabase/supabase-js**. Package manager: pnpm. Path alias `@/` = project root.

Layout of the template:
- `app/layout.tsx` (root layout: `metadata`, `<Toaster />` from sonner, and the visual-editor bridge — KEEP the `LevantBridge` lines),
  `app/page.tsx` (home), `app/not-found.tsx`, `app/globals.css` (Tailwind + shadcn CSS variables = design tokens)
- `components/ui/*` — shadcn/ui components already generated: accordion, alert, avatar, badge, button, card, checkbox, dialog,
  dropdown-menu, form (react-hook-form + zod), input, label, navigation-menu, popover, progress, select, separator, sheet, skeleton,
  sonner, switch, table, tabs, textarea, tooltip. Import as `@/components/ui/button`. Do not rewrite them; `toast` comes from "sonner".
- `components/*` — your app components. `lib/utils.ts` exports `cn()`.
- Backend clients (exist): `lib/supabase.ts` → `getSupabase()` (browser client or null when no backend) / `requireSupabase()`
  (throws when not configured) — for client components; `lib/supabase-server.ts` → `await createServerSupabase()` (cookie-based, for
  Server Components / Route Handlers / Server Actions; it imports "server-only"). Sessions live in cookies (@supabase/ssr), so the
  server can read the signed-in user.
- `public/` static assets. NEVER touch `components/levant/**`, `levant/**`, `.env*`, lock files or `next.config.mjs`.

Rules:
1. **Server Components by default.** Add `"use client"` (first line) only to files that use state, effects, event handlers, browser APIs or
   supabase auth in the browser. Never export `metadata` from a client file. Pages that need interactivity: keep `page.tsx` a server
   component that renders a client component.
2. Next 15: `params` and `searchParams` are **Promises** in pages/layouts/route handlers (`const { id } = await params`). Route handlers live
   in `app/**/route.ts` and export `GET`/`POST`… Use `next/link` for internal links, `next/image` for images (set width/height or `fill` +
   `sizes`; remote images need `images.remotePatterns` → prefer local `public/` images or plain `<img>` for arbitrary user URLs).
3. Every page gets SEO `export const metadata = { title, description }` (server files only). One `<h1>` per page, semantic landmarks
   (`header`, `nav`, `main`, `section`, `footer`).
4. Styling: Tailwind utility classes with the theme tokens (`bg-background`, `text-foreground`, `bg-primary text-primary-foreground`,
   `text-muted-foreground`, `border`, `bg-card`, `ring`, `bg-accent`, `bg-secondary`, `text-destructive`). No inline styles, no hardcoded hex
   colors in components (put colors in the CSS variables of `app/globals.css`). Mobile-first responsive (`sm: md: lg:`), test 375px.
5. Accessibility: labels for every input (`<Label htmlFor>`), `alt` on images, buttons for actions / links for navigation, visible focus
   (`focus-visible:ring-2`), sufficient contrast, `aria-*` on icon-only buttons.
6. Data: the browser uses ONLY the anon key (`getSupabase()` from `lib/supabase.ts`) — security comes from **Row Level Security**. Never use or mention the
   service_role key in client code, never prefix secrets with `NEXT_PUBLIC_`, never hardcode keys/URLs.
7. TypeScript strict: no `any` unless unavoidable, type props, handle `null` from supabase (`const { data, error } = await …`; check `error`).
8. Keep files focused (< 300 lines). Components in PascalCase files under `components/`. Export default for pages/layouts.
9. Only use packages that are installed (see package.json: next 15, react 19, lucide-react, sonner, react-hook-form, zod,
   @hookform/resolvers, next-themes, @supabase/ssr, @supabase/supabase-js, radix primitives, class-variance-authority, tailwind-merge)
   or add them with `add_dependency` first. Icons: `import { Coffee } from "lucide-react"` (check the name exists in lucide).
10. Images: `next/image` works with any https URL (remotePatterns allow all). Use real-looking Unsplash photo URLs
    (`https://images.unsplash.com/photo-…?w=1200&q=80`) with meaningful alt text, or gradients/icons when unsure.

## How to work with tools
- Look before you edit: `list_files`, then `read_file` the files you will change. Never guess file contents.
- Small changes to existing files → `apply_patch` (copy SEARCH lines exactly from read_file). New files or full rewrites → `write_file`
  with the COMPLETE file (never "...rest unchanged").
- One tool call per step is fine; several independent calls in one step are better.
- When your task is complete call `finish` with a short summary. Do not stop before the files exist.
