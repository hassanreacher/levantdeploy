import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, Check, Terminal } from "lucide-react";
import { MarketingShell, PageHero } from "@/components/landing/marketing-shell";
import { BACKEND_FEATURES, BUILDER_FEATURES, DEPLOY_FEATURES, type Feature } from "@/components/landing/content";
import { SectionHeading, primaryCta } from "@/components/landing/site-chrome";
import { marketingContext } from "@/components/landing/mode";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Features",
  description: "Deployments, previews, domains with automatic HTTPS, rollbacks, logs, a built-in backend (Postgres, auth, REST, realtime, storage, functions, Studio), an AI agent and a CLI.",
};

const AGENT = [
  "Explains failed builds and crashing deployments from the actual logs",
  "Proposes env var changes, redeploys, rollbacks and domain changes as approval cards",
  "Reads backend schemas and runs SQL — writes only after approval",
  "Uses your own Anthropic API key; every action lands in the audit log",
];
const CLI = [
  "levant login — browser-based device login",
  "levant deploy [--prod] — upload this folder, stream the build",
  "levant link / ls / open / whoami",
  "levant logs -f, levant rollback",
  "levant env add | rm | ls | pull",
  "levant domains add | verify | rm",
];

export default async function FeaturesPage() {
  const { mode, signedIn } = await marketingContext();
  const primary = primaryCta(mode);
  return (
    <MarketingShell mode={mode} signedIn={signedIn}>
      <PageHero
        eyebrow="Features"
        title="Describe it. We build it, host it, and give it a backend."
        text="An AI app builder, a deployment platform, a complete backend, an ops agent and a CLI — one product you run on your own server."
      />

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <SectionHeading eyebrow="AI Builder" title="From a prompt to a published app." text="A team of AI agents builds a real full-stack app you can edit visually, keep in version history and own completely." />
        <FeatureGrid items={BUILDER_FEATURES} cols4 />
      </section>

      <section className="border-t border-border bg-bg-subtle/60">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading eyebrow="Deployments" title="Ship any stack, safely." text="Projects built by the AI and projects from your own repositories share the same deployment pipeline." />
          <FeatureGrid items={DEPLOY_FEATURES} />
        </div>
      </section>
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="Backend included"
            title="A backend in every project."
            text="Each project can switch on its own isolated backend. The URL and keys are injected into the project's environment, and the official supabase-js client works unchanged."
          />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {BACKEND_FEATURES.map((f, i) => (
              <div key={f.title} className="rounded-xl border border-border bg-surface p-5" data-reveal style={{ ["--lf-delay" as string]: `${(i % 4) * 70}ms` }}>
                <f.icon />
                <h2 className="mt-4 text-[15px] font-semibold">{f.title}</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-bg-subtle/60">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-20 sm:px-6 md:grid-cols-2">
          {[
            { icon: Bot, title: "AI ops agent", items: AGENT },
            { icon: Terminal, title: "CLI", items: CLI },
          ].map((b) => (
            <div key={b.title} className="rounded-xl border border-border bg-surface p-6" data-reveal>
              <b.icon className="h-5 w-5 text-accent" />
              <h2 className="mt-4 text-xl font-semibold tracking-tight">{b.title}</h2>
              <ul className="mt-4 space-y-2 text-[13px] text-muted">
                {b.items.map((m) => (
                  <li key={m} className="flex gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg" /> <span className={b.title === "CLI" ? "font-mono text-[12.5px]" : undefined}>{m}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 pb-24 sm:flex-row sm:justify-center sm:px-6">
          <Link href={primary.href} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-fg px-5 text-sm font-medium text-bg transition-opacity hover:opacity-90 sm:w-auto">
            {primary.label} <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/pricing" className="inline-flex h-11 w-full items-center justify-center rounded-md border border-border bg-surface px-5 text-sm font-medium text-fg transition-colors hover:border-border-strong sm:w-auto">
            See plans
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}

function FeatureGrid({ items, cols4 }: { items: Feature[]; cols4?: boolean }) {
  return (
    <div className={cols4 ? "mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" : "mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
      {items.map((f, i) => (
        <div key={f.title} className="rounded-xl border border-border bg-surface p-6" data-reveal style={{ ["--lf-delay" as string]: `${(i % 3) * 70}ms` }}>
          <f.icon className="h-5 w-5 text-accent" />
          <h2 className="mt-4 text-[15px] font-semibold">{f.title}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{f.text}</p>
          {f.more && (
            <ul className="mt-4 space-y-1.5 text-[13px] text-muted">
              {f.more.map((m) => (
                <li key={m} className="flex gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg" /> {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
