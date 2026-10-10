# Next.js 15 App Router cheat sheet
- Files: `app/page.tsx` (route `/`), `app/about/page.tsx` (`/about`), `app/blog/[slug]/page.tsx`, `app/layout.tsx` (wraps children),
  `app/loading.tsx`, `app/error.tsx` (must be "use client"), `app/not-found.tsx`, `app/api/x/route.ts` (route handler).
- Server Component (default): can be `async`, fetch data, read env; cannot use useState/useEffect/onClick.
- Client Component: `"use client"` as the FIRST line. Needed for hooks, event handlers, browser APIs, supabase auth state.
- Params are Promises in Next 15:
  ```tsx
  export default async function Page({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; … }
  export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; return Response.json({ id }); }
  ```
  In client components use `useParams()` / `useSearchParams()` (wrap the component using useSearchParams in `<Suspense>`).
- Metadata (server files only): `export const metadata: Metadata = { title: "…", description: "…" }` (`import type { Metadata } from "next"`).
  Dynamic: `export async function generateMetadata({ params }) { … }`.
- Navigation: `import Link from "next/link"`; client redirect `useRouter().push("/x")` from `next/navigation`; server `redirect("/x")`.
- Images: `import Image from "next/image"` → `<Image src="/hero.jpg" alt="…" width={1200} height={800} priority />` or `fill` + `sizes`
  inside a `relative` parent. Any https host is allowed in this template (remotePatterns `**`).
- Fonts: `import { Inter } from "next/font/google"; const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })` → `<body className={inter.variable}>`.
- Server Actions: `"use server"` functions; form `<form action={action}>`; use `useActionState` (React 19) in client components.
- Don't import server-only modules into client components. `process.env.X` is only available on the server unless prefixed `NEXT_PUBLIC_`.
- ESLint (next/core-web-vitals): escape `'` and `"` in JSX text (`&apos;`, `&quot;`), no unused vars, hooks rules, `<a>` → `<Link>` for internal routes.
