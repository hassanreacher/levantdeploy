import Link from "next/link";
import { ArrowRight, Check, Cpu, GitBranch, Globe2, HardDrive, History, LayoutGrid, MousePointer2, Palette, Plus, Rocket, ServerCog, Sparkles, Terminal, Upload, Wand2 } from "lucide-react";
import { BuilderPromptHero } from "@/components/builder/builder-prompt-hero";
import { cn } from "@/lib/utils";
import { HeroVisual } from "./hero-visual";
import { AgentTeam } from "./agent-team";
import { VisualEditDemo } from "./visual-edit-demo";
import { ExampleGallery } from "./example-gallery";
import { RevealObserver } from "./reveal-observer";
import { TerminalDemo } from "./terminal-demo";
import { AgentDemo } from "./agent-demo";
import { CopyCommand } from "./copy-command";
import { PricingCards } from "./pricing-cards";
import { BACKEND_FEATURES, DEPLOY_FEATURES, FAQ, INSTALL_COMMAND } from "./content";
import { SectionHeading, SiteFooter, SiteHeader, primaryCta, type RegistrationMode } from "./site-chrome";
import type { PublicPlan } from "./plans";
import "./landing.css";

const STACKS = ["Next.js", "Nuxt", "Remix", "Astro", "SvelteKit", "Vite", "Django", "FastAPI", "Laravel", "Rails", "Go", "Rust", "Spring", ".NET", "Dockerfile"];

export function Landing({ mode, plans }: { mode: RegistrationMode; plans: PublicPlan[] }) {
  const primary = primaryCta(mode);
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <RevealObserver />
      <SiteHeader mode={mode} />

      <main>
        {/* ───────────────────────── Hero ───────────────────────── */}
        <section className="relative isolate overflow-hidden" aria-labelledby="hero-title">
          <div className="lf-hero-bg pointer-events-none absolute inset-0 -z-10" />
          <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px] grid-bg [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]" />
          <div className="mx-auto max-w-6xl px-4 pt-10 text-center sm:px-6 sm:pt-14">
            <p className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1 text-[12px] text-muted backdrop-blur animate-fade-in">
              <Sparkles className="h-3.5 w-3.5 text-accent" /> AI app builder · hosting · backend — self-hosted
            </p>
            <h1 id="hero-title" className="lf-gradient-text mx-auto max-w-4xl text-balance text-[2.35rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-[4.25rem]">
              Describe it. We build it, host it, and give it a backend.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-pretty text-[15px] leading-relaxed text-muted sm:text-lg">
              A team of AI agents turns your idea into a full-stack app with its own database, auth and storage. Edit it like a website, publish it to
              your domain in one click — or bring your own code. All on a server you own.
            </p>
            <BuilderPromptHero showHeading={false} signUpHref={mode === "invite" ? "/login" : "/register"} className="mt-8 text-left" />
            <p className="mt-5 text-[13px] text-muted">
              Have code already?{" "}
              <a href="#how" className="link">
                Deploy from Git or the CLI
              </a>
              {mode === "setup" && <span className="block pt-1 sm:inline sm:pl-2 sm:pt-0">· No account exists yet — the first account becomes the platform owner.</span>}
            </p>
          </div>

          <HeroVisual className="mx-auto -mt-2 h-[250px] w-full max-w-6xl sm:-mt-6 sm:h-[360px] lg:h-[400px]" />

          <ol className="mx-auto -mt-2 grid max-w-5xl grid-cols-2 gap-x-4 gap-y-2 px-4 pb-16 text-[12px] text-muted sm:grid-cols-4 sm:px-6 sm:pb-20" aria-label="What the animation shows">
            {[
              { icon: GitBranch, t: "Prompt or git push", d: "AI-built or your code" },
              { icon: Cpu, t: "Build", d: "any stack, real containers" },
              { icon: Globe2, t: "Edge", d: "HTTPS on your domains" },
              { icon: HardDrive, t: "Backend", d: "Postgres + realtime" },
            ].map((s, i) => (
              <li key={s.t} className="flex items-center justify-center gap-2" data-reveal style={{ ["--lf-delay" as string]: `${i * 90}ms` }}>
                <s.icon className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span>
                  <span className="font-medium text-fg">{s.t}</span> <span className="hidden whitespace-nowrap lg:inline">· {s.d}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* stacks strip */}
        <section aria-label="Supported stacks" className="border-y border-border bg-bg-subtle/60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 py-5 font-mono text-[12px] text-subtle sm:px-6">
            <span className="text-muted">Deploys</span>
            {STACKS.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        </section>

        {/* ───────────────────────── Builder: how the AI builds ───────────────────────── */}
        <section id="builder" className="relative isolate scroll-mt-20 overflow-hidden">
          <div className="pointer-events-none absolute -left-40 top-10 -z-10 h-[480px] w-[480px] rounded-full bg-accent/10 blur-3xl" />
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <SectionHeading
              eyebrow="How the AI builds"
              title="A whole team of agents, not one chatbot."
              text="A planner writes the spec, a designer sets the look, coders and a backend agent write the app and its database, a reviewer runs the type-checker and a real build, and a fixer repairs what fails — until it's green. Then you publish."
            />
            <AgentTeam className="mt-12" />
            <ul className="mt-8 grid gap-3 text-[13px] text-muted sm:grid-cols-3" data-reveal>
              {[
                "Next.js 15 + Tailwind + shadcn/ui — real code you can read, export and keep",
                "Every agent turn is a git commit — restore any version in one click",
                "Many AI providers with automatic fallback when one is slow or rate-limited",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> {t}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ───────────────────────── Builder: visual editing ───────────────────────── */}
        <section id="editor" className="scroll-mt-20 border-t border-border bg-bg-subtle/60">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[1fr_1.25fr]">
            <div>
              <SectionHeading
                eyebrow="Visual editing"
                title="Edit like a website editor."
                text="No code required after the first prompt. Click any element on the live preview to change its text, swap an image or restyle it — or drag sections into a new order. Prefer words? Just ask the AI."
              />
              <ul className="mt-8 space-y-3 text-[14px]" data-reveal>
                {[
                  { icon: MousePointer2, t: "Click to select, type to change text inline" },
                  { icon: Palette, t: "Style panel for colours, spacing, fonts and radius" },
                  { icon: LayoutGrid, t: "Drag-and-drop sections and a library of ready blocks" },
                  { icon: History, t: "Version history, ZIP export and push to GitHub" },
                ].map((r) => (
                  <li key={r.t} className="flex gap-2.5 text-muted">
                    <r.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> {r.t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="min-w-0" data-reveal>
              <VisualEditDemo />
            </div>
          </div>
        </section>

        {/* ───────────────────────── Builder: examples ───────────────────────── */}
        <section id="examples" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <SectionHeading eyebrow="Made with the Builder" title="From one sentence to a working app." text="A few things people describe in a single prompt — each one ships with its own database, sign-in and file storage." />
            <div className="mt-12">
              <ExampleGallery />
            </div>
          </div>
        </section>

        {/* ───────────────────────── How it works ───────────────────────── */}
        <section id="how" className="scroll-mt-20 border-t border-border bg-bg-subtle/60">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <SectionHeading eyebrow="Bring your own code" title="Already have code? Live in under a minute." text="Connect a repository or upload a folder. LevantDeploy builds a container, health-checks it and switches traffic — without dropping a request. Apps made with the Builder publish through the same pipeline." />
            <HowItWorks />
          </div>
        </section>

        {/* ───────────────────────── Deployments ───────────────────────── */}
        <section id="platform" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <SectionHeading eyebrow="Deployments" title="Everything you expect from a modern cloud." text="Without per-seat pricing, cold starts or function timeouts. Every deployment is a real container on your hardware." />
              <Link href="/features" className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-fg" data-reveal>
                All features <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {DEPLOY_FEATURES.slice(0, 9).map((f, i) => (
                <div key={f.title} className="group bg-bg p-6 transition-colors hover:bg-surface" data-reveal style={{ ["--lf-delay" as string]: `${(i % 3) * 70}ms` }}>
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface transition-colors group-hover:border-accent/50">
                    <f.icon className="h-4 w-4 text-fg transition-colors group-hover:text-accent" />
                  </span>
                  <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────────── Backend ───────────────────────── */}
        <section id="backend" className="relative isolate scroll-mt-20 overflow-hidden border-t border-border bg-bg-subtle/60">
          <div className="pointer-events-none absolute -right-40 top-20 -z-10 h-[520px] w-[520px] rounded-full bg-accent/10 blur-3xl" />
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <SectionHeading
              eyebrow="Backend included"
              title="Every app comes with a backend."
              text={
                <>
                  The Builder&apos;s backend agent creates the tables (with row-level security), sign-in pages and storage buckets your app needs. Every project
                  — built or deployed — can switch on Postgres, auth, an instant REST API, realtime, storage, edge functions and Studio, with the keys injected
                  into its environment. Works with <span className="font-mono text-[0.9em] text-fg">supabase-js</span> out of the box.
                </>
              }
            />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {BACKEND_FEATURES.map((f, i) => (
                <div key={f.title} className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-strong" data-reveal style={{ ["--lf-delay" as string]: `${(i % 4) * 70}ms` }}>
                  <f.icon />
                  <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{f.text}</p>
                </div>
              ))}
              <div className="flex min-w-0 flex-col justify-between rounded-xl border border-accent/40 bg-accent/[0.06] p-5" data-reveal style={{ ["--lf-delay" as string]: "210ms" }}>
                <pre className="overflow-x-auto font-mono text-[11.5px] leading-5 text-muted">
                  <span className="text-accent">import</span> {"{ createClient }"} <span className="text-accent">from</span>
                  {"\n  "}
                  <span className="text-fg">&quot;@supabase/supabase-js&quot;</span>
                  {"\n\n"}
                  <span className="text-accent">const</span> db = createClient({"\n"}
                  {"  "}process.env.<span className="text-fg">SUPABASE_URL</span>,{"\n"}
                  {"  "}process.env.<span className="text-fg">SUPABASE_ANON_KEY</span>{"\n"}){"\n\n"}
                  <span className="text-accent">await</span> db.from(<span className="text-fg">&quot;orders&quot;</span>).select()
                </pre>
                <p className="mt-4 text-[12px] text-muted">Env vars are added to your deployments automatically.</p>
              </div>
            </div>
            <p className="mt-6 text-[12px] text-subtle" data-reveal>
              The backend engine (LevantBase) is assembled from the official open-source components and runs per project in isolated containers on your server.
            </p>
          </div>
        </section>

        {/* ───────────────────────── AI agent ───────────────────────── */}
        <section id="agent" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2">
            <div>
              <SectionHeading
                eyebrow="AI ops agent"
                title="An engineer on call that asks before it acts."
                text="Built on Claude, the agent reads your build and runtime logs, settings and backend schema to explain what went wrong — then proposes the fix as actions you approve."
              />
              <ul className="mt-8 space-y-3 text-[14px]" data-reveal>
                {[
                  "Diagnoses failed builds and crashing deployments",
                  "Sets env vars, redeploys, rolls back, adds domains",
                  "Inspects tables and runs SQL against your backend",
                  "Every action needs your approval and is audit-logged",
                ].map((t) => (
                  <li key={t} className="flex gap-2.5 text-muted">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="min-w-0" data-reveal>
              <AgentDemo />
            </div>
          </div>
        </section>

        {/* ───────────────────────── CLI ───────────────────────── */}
        <section id="cli" className="scroll-mt-20 border-t border-border bg-bg-subtle/60">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2">
            <div className="order-2 min-w-0 lg:order-1" data-reveal>
              <TerminalDemo />
            </div>
            <div className="order-1 lg:order-2">
              <SectionHeading eyebrow="CLI" title="Deploy from your terminal." text="Ship the folder you're in — no repository required. Logs stream live, and the URL is ready when the command returns." />
              <div className="mt-8 grid gap-2 font-mono text-[12.5px]" data-reveal>
                {[
                  ["levant login", "authenticate in the browser"],
                  ["levant deploy --prod", "build & ship this folder"],
                  ["levant logs -f", "follow runtime logs"],
                  ["levant env pull", "write .env.local"],
                  ["levant rollback", "back to the previous release"],
                ].map(([c, d]) => (
                  <div key={c} className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-md border border-border bg-surface px-3 py-2">
                    <span className="text-fg">
                      <span className="text-subtle">$ </span>
                      {c}
                    </span>
                    <span className="font-sans text-[12px] text-subtle">{d}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────────── Self-host ───────────────────────── */}
        <section id="self-host" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <SectionHeading center eyebrow="Self-host" title="One command. Your own cloud." text="The installer sets up Docker, the control plane, the build worker and the edge proxy with automatic HTTPS on a fresh Ubuntu or Debian server." />
            <div className="mx-auto mt-10 max-w-3xl" data-reveal>
              <CopyCommand command={INSTALL_COMMAND} />
            </div>
            <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-3">
              {[
                { icon: ServerCog, t: "Any VPS", d: "Ubuntu 22.04 / 24.04 or Debian 12, x86_64 or arm64, 2 GB RAM and up." },
                { icon: Globe2, t: "Point your DNS", d: "An A record for the dashboard and a wildcard for apps and previews." },
                { icon: Rocket, t: "Deploy", d: "Create the owner account, connect GitHub or run levant deploy." },
              ].map((s, i) => (
                <div key={s.t} className="rounded-xl border border-border bg-surface p-5" data-reveal style={{ ["--lf-delay" as string]: `${i * 80}ms` }}>
                  <s.icon className="h-5 w-5 text-accent" />
                  <h3 className="mt-3 text-[15px] font-semibold">{s.t}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.d}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-[13px] text-muted" data-reveal>
              Idempotent, re-runnable and with backup / restore / update scripts included.{" "}
              <Link href="/docs" className="link">
                Installation guide
              </Link>
            </p>
          </div>
        </section>

        {/* ───────────────────────── Pricing teaser ───────────────────────── */}
        <section id="pricing" className="scroll-mt-20 border-t border-border bg-bg-subtle/60">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <SectionHeading eyebrow="Plans" title="Start free. Grow without surprises." text="Every plan includes AI Builder credits, deployments and a backend. Limits are set by the operator of this server." />
              <Link href="/pricing" className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-fg" data-reveal>
                Compare plans <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="mt-12">
              <PricingCards plans={plans} ctaHref={primary.href} compact />
            </div>
          </div>
        </section>

        {/* ───────────────────────── FAQ ───────────────────────── */}
        <section id="faq" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-24 sm:px-6 lg:grid-cols-[1fr_1.6fr]">
            <SectionHeading eyebrow="FAQ" title="Questions, answered." text="Can't find what you're looking for? The docs cover installation, usage and the backend in depth." />
            <div className="divide-y divide-border rounded-xl border border-border bg-bg" data-reveal>
              {FAQ.map((f) => (
                <details key={f.q} className="lf-faq group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[14px] font-medium text-fg transition-colors hover:bg-surface">
                    {f.q}
                    <Plus className="lf-faq-icon h-4 w-4 shrink-0 text-muted transition-transform" aria-hidden />
                  </summary>
                  <p className="px-5 pb-5 text-[14px] leading-relaxed text-muted">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────────── Final CTA ───────────────────────── */}
        <section className="relative isolate overflow-hidden border-t border-border">
          <div className="lf-hero-bg pointer-events-none absolute inset-0 -z-10 opacity-80" />
          <div className="mx-auto max-w-6xl px-4 py-24 text-center sm:px-6" data-reveal>
            <Sparkles className="mx-auto h-6 w-6 text-accent" />
            <h2 className="mx-auto mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">Build your next app on your own cloud.</h2>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href={primary.href} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-fg px-5 text-sm font-medium text-bg transition-opacity hover:opacity-90 sm:w-auto">
                {primary.label} <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="/login" className="inline-flex h-11 w-full items-center justify-center rounded-md border border-border bg-surface px-5 text-sm font-medium text-fg transition-colors hover:border-border-strong sm:w-auto">
                Log in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

/** Connect → Build → Live, with a pulse travelling along the connector (CSS only). */
function HowItWorks() {
  const steps = [
    {
      n: "01",
      icon: GitBranch,
      title: "Connect",
      text: "Import a GitHub repo, any Git URL, or upload from your PC.",
      body: (
        <ul className="space-y-1.5 font-mono text-[12px]">
          {[
            { i: GitBranch, t: "github.com/acme/storefront", on: true },
            { i: GitBranch, t: "git@gitlab.com:acme/api.git" },
            { i: Upload, t: "levant deploy ./my-app" },
          ].map((r) => (
            <li key={r.t} className={cn("flex items-center gap-2 truncate rounded-md border px-2 py-1.5", r.on ? "border-accent/50 bg-accent/10 text-fg" : "border-border text-muted")}>
              <r.i className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{r.t}</span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      n: "02",
      icon: Wand2,
      title: "Build",
      text: "The framework is detected, dependencies cached and a container image built.",
      body: (
        <div className="space-y-2.5 font-mono text-[12px] text-muted">
          {[
            ["install", "0s"],
            ["build", ".6s"],
            ["image", "1.2s"],
          ].map(([l, d]) => (
            <div key={l} className="flex items-center gap-2">
              <span className="w-12 shrink-0">{l}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <span className="lf-anim-bar block h-full w-full rounded-full bg-accent" style={{ animationDelay: d }} />
              </span>
            </div>
          ))}
        </div>
      ),
    },
    {
      n: "03",
      icon: Rocket,
      title: "Live",
      text: "Health-checked, switched with zero downtime and served over HTTPS.",
      body: (
        <div className="space-y-2 font-mono text-[12px]">
          <div className="flex items-center gap-2 truncate rounded-md border border-border px-2 py-1.5 text-fg">
            <span className="lf-anim-blink h-2 w-2 shrink-0 rounded-full bg-success" /> <span className="truncate">storefront.example.com</span>
          </div>
          <div className="flex justify-between px-1 text-muted">
            <span>200 OK</span>
            <span>TLS ✓</span>
            <span>38 ms</span>
          </div>
        </div>
      ),
    },
  ];
  return (
    <div className="relative mt-14">
      {/* connector line (desktop horizontal, mobile vertical) */}
      <div className="pointer-events-none absolute left-[16.6%] right-[16.6%] top-[30px] hidden h-px bg-gradient-to-r from-border via-border-strong to-border md:block" aria-hidden>
        <span className="lf-anim-travel absolute -top-[3px] h-[7px] w-16 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_16px_4px_rgb(var(--accent)/0.6)]" />
      </div>
      <div className="pointer-events-none absolute bottom-10 left-[30px] top-10 w-px bg-border-strong md:hidden" aria-hidden>
        <span className="lf-anim-travel-y absolute -left-[3px] h-16 w-[7px] -translate-y-1/2 rounded-full bg-accent shadow-[0_0_16px_4px_rgb(var(--accent)/0.6)]" />
      </div>
      <ol className="relative grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.n} className="relative min-w-0 pl-[76px] md:pl-0" data-reveal style={{ ["--lf-delay" as string]: `${i * 120}ms` }}>
            <span className="absolute left-0 top-0 flex h-[60px] w-[60px] items-center justify-center rounded-2xl border border-border-strong bg-bg md:relative md:mx-auto">
              <s.icon className="h-5 w-5 text-fg" />
              <span className="absolute -right-2 -top-2 rounded-full border border-border bg-surface px-1.5 font-mono text-[10px] text-muted">{s.n}</span>
            </span>
            <div className="rounded-xl border border-border bg-surface p-5 md:mt-6">
              <h3 className="text-[15px] font-semibold">{s.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.text}</p>
              <div className="mt-4">{s.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-8 flex items-center justify-center gap-2 text-center text-[13px] text-muted">
        <Terminal className="h-4 w-4 shrink-0" /> Every branch and pull request gets its own preview URL, too.
      </p>
    </div>
  );
}
