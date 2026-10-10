import {
  Activity,
  Download,
  MousePointer2,
  Rocket,
  Shuffle,
  Sparkles,
  Bot,
  Clock,
  Database,
  Eye,
  GitBranch,
  Globe,
  History,
  KeyRound,
  Layers,
  ShieldCheck,
  Terminal,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AuthIcon, DatabaseIcon, FunctionsIcon, RealtimeIcon, RestIcon, StorageIcon, StudioIcon } from "./backend-icons";

export type Feature = { icon: LucideIcon; title: string; text: string; more?: string[] };

export const DEPLOY_FEATURES: Feature[] = [
  {
    icon: GitBranch,
    title: "Push to deploy",
    text: "Connect GitHub or any Git URL. Every push builds and ships; every branch and pull request gets its own preview URL.",
    more: ["GitHub App with commit statuses & PR comments", "Any Git host via URL + deploy key", "Deploy hooks for CI"],
  },
  {
    icon: Layers,
    title: "Any stack, real containers",
    text: "Next.js, Nuxt, Astro, Django, Laravel, Rails, Go, Rust, Spring, .NET — or your own Dockerfile. Long-running processes and WebSockets included.",
    more: ["Framework auto-detection", "Dockerfile & docker-compose", "No cold starts, no function timeouts"],
  },
  {
    icon: Eye,
    title: "Preview deployments",
    text: "A unique, shareable URL for every deployment and every branch — protected by password or team login when you want.",
    more: ["{project}-{id} and {project}-git-{branch} URLs", "Deployment protection", "Promote a preview to production"],
  },
  {
    icon: Globe,
    title: "Domains & automatic HTTPS",
    text: "Add custom domains with www redirects; certificates are issued and renewed automatically by the edge proxy.",
    more: ["On-demand TLS", "Apex + wildcard support", "Redirects between domains"],
  },
  {
    icon: History,
    title: "Instant rollback",
    text: "Zero-downtime traffic switches after health checks. Roll back to any previous release in one click.",
    more: ["Health-checked switches", "Previous containers kept warm", "Full deployment history"],
  },
  {
    icon: Activity,
    title: "Logs & metrics",
    text: "Streaming build and runtime logs, CPU / memory / bandwidth charts and request metrics for every project.",
    more: ["Live SSE log streaming", "Searchable, downloadable logs", "Usage per team"],
  },
  {
    icon: Database,
    title: "Databases & add-ons",
    text: "Postgres, MySQL, Redis and MongoDB next to your app, with credentials injected as environment variables and scheduled backups.",
  },
  {
    icon: Clock,
    title: "Cron & workers",
    text: "Scheduled jobs and background workers run alongside your app — no extra services to rent.",
  },
  {
    icon: KeyRound,
    title: "Encrypted environment",
    text: "Production, preview and development values, per-branch overrides and shared groups — AES-256 encrypted at rest.",
  },
  {
    icon: Terminal,
    title: "Deploy from your PC",
    text: "levant deploy uploads the current folder (respecting .gitignore) and streams the build to your terminal.",
  },
  {
    icon: Users,
    title: "Teams & roles",
    text: "Owner, admin, member and viewer roles, invitations, scoped API tokens, two-factor login and a full audit log.",
  },
  {
    icon: ShieldCheck,
    title: "Self-hosted & private",
    text: "Your code, data and logs never leave your server. One command installs everything on a fresh VPS.",
  },
];

export type BackendFeature = { icon: () => React.ReactElement; title: string; text: string };

export const BACKEND_FEATURES: BackendFeature[] = [
  { icon: DatabaseIcon, title: "Database", text: "A dedicated Postgres per project with extensions, row-level security, backups and a public port when you need it." },
  { icon: AuthIcon, title: "Auth", text: "Email & password, magic links, OAuth providers and JWTs — users stored in your own database." },
  { icon: RestIcon, title: "Instant REST API", text: "Every table is an API the moment you create it — filter, paginate and join, guarded by your RLS policies." },
  { icon: RealtimeIcon, title: "Realtime", text: "Subscribe to inserts, updates and deletes, broadcast messages and track presence over WebSockets." },
  { icon: StorageIcon, title: "Storage", text: "Buckets for files and images with policies, signed URLs and on-the-fly image transformations." },
  { icon: FunctionsIcon, title: "Edge Functions", text: "TypeScript functions on a Deno runtime with secrets, JWT verification and logs — deploy from the CLI." },
  { icon: StudioIcon, title: "Studio", text: "A full table editor, SQL editor, auth & storage manager — opened with single sign-on from your dashboard." },
];

export const BUILDER_FEATURES: Feature[] = [
  {
    icon: Sparkles,
    title: "Describe it, get an app",
    text: "Type what you want in plain words — or attach a screenshot. Agents plan, design and write a full-stack Next.js 15 + Tailwind + shadcn/ui app.",
    more: ["Planner, designer, coders, backend agent", "Reviewer runs tsc, lint and a real build", "Fixer loops until the build is green"],
  },
  {
    icon: Database,
    title: "Backend built for you",
    text: "The backend agent creates tables with row-level security, sign-in pages, storage buckets and edge functions in the project's own backend.",
  },
  {
    icon: MousePointer2,
    title: "Visual editing",
    text: "Click to edit text, replace images, restyle in a side panel and drag sections around — like a website editor, on real code.",
    more: ["Inline text editing", "Style panel & component library", "Ask the AI about a selected element"],
  },
  {
    icon: Eye,
    title: "Live preview",
    text: "See every change instantly in a live preview, share a read-only preview link with a client and catch runtime errors automatically.",
  },
  {
    icon: History,
    title: "Version history",
    text: "Every AI turn and every visual edit is a commit. Compare versions and restore any of them in one click.",
  },
  {
    icon: Rocket,
    title: "One-click publish",
    text: "Publish to a URL on your server, add a custom domain with automatic HTTPS, and keep editing — the next publish is zero-downtime.",
  },
  {
    icon: Download,
    title: "Own the code",
    text: "Download a ZIP or export to a GitHub repository at any time. It's a normal Next.js app — no lock-in.",
  },
  {
    icon: Shuffle,
    title: "Many AI providers",
    text: "Gemini, Groq, OpenRouter, Mistral, NVIDIA, Cloudflare Workers AI, Ollama, Claude and any OpenAI-compatible endpoint — with automatic fallback.",
  },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "What can the AI Builder make?",
    a: "Websites and full-stack web apps: landing pages, shops and booking sites, dashboards, portals, internal tools, communities. It writes a real Next.js 15 + TypeScript + Tailwind + shadcn/ui project with its own database, auth and storage, and you can keep editing it visually, by chat, or in code.",
  },
  {
    q: "Which AI models does the Builder use?",
    a: "The server operator chooses: Gemini, Groq, OpenRouter, Mistral, NVIDIA, Cloudflare Workers AI, Ollama, Anthropic Claude or any OpenAI-compatible endpoint. A router tracks health and rate limits and falls back to the next provider automatically, resuming the run from the last completed step.",
  },
  {
    q: "Who owns the code and the data?",
    a: "You do. The code lives in a git repository on your own server and can be downloaded as a ZIP or exported to GitHub at any time; the data lives in your project's own Postgres database. Prompts are sent only to the AI providers the operator enabled — providers known to log prompts are off by default.",
  },
  {
    q: "What is a Builder credit?",
    a: "One message to the AI agents — a new app, a change request or a fix. Visual edits, previews and publishing don't use credits. Each plan has a daily and/or monthly allowance.",
  },
  {
    q: "Is it really one product?",
    a: "Yes. A LevantDeploy project holds your app — built by the AI Builder or deployed from your own code — its deployments and domains, and a built-in backend: database, auth, storage, realtime, functions and Studio. The backend's URL and keys are injected into your app's environment automatically.",
  },
  {
    q: "Do I need to change my code to use the backend?",
    a: "No. The backend speaks the same APIs as the popular open-source stack it's built from, so the official supabase-js client (and other clients for it) work unchanged — point them at your project URL and anon key.",
  },
  {
    q: "What does the AI agent have access to?",
    a: "It can read your project's deployments, logs, settings and backend schema to diagnose problems. Every change it proposes — env vars, redeploys, domains, SQL — is shown as an action card and only runs after you approve it, and everything is recorded in the audit log.",
  },
  {
    q: "What do I need to self-host?",
    a: "A Linux server (Ubuntu 22.04/24.04 or Debian 12) with 2 GB RAM or more, ports 80/443 open and a domain with a wildcard DNS record. The installer sets up Docker, the control plane, the worker and the edge proxy with automatic HTTPS.",
  },
  {
    q: "Which languages and frameworks can I deploy?",
    a: "Anything that runs in a container. Popular frameworks are detected automatically (Next.js, Nuxt, Remix, Astro, SvelteKit, Vite, Django, FastAPI, Flask, Laravel, Rails, Go, Rust, Spring, .NET and more); otherwise bring a Dockerfile or docker-compose file.",
  },
  {
    q: "How do plans and limits work on a self-hosted server?",
    a: "The operator of the server defines plans (Hobby, Pro, Team…) with limits for deployments and backends, and assigns them to teams. There is no built-in billing — prices are shown for reference.",
  },
  {
    q: "Can I roll back if a deployment breaks production?",
    a: "Instantly. Previous deployments stay available, and promoting one switches traffic after a health check — no rebuild needed.",
  },
];

export const INSTALL_COMMAND = "curl -fsSL https://<your-host>/install.sh | sudo bash -s -- --domain example.com --email you@example.com";
