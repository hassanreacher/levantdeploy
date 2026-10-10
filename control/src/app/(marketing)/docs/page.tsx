import type { Metadata } from "next";
import { BookOpen, Database, Globe, Rocket, ServerCog, Terminal } from "lucide-react";
import { MarketingShell, PageHero } from "@/components/landing/marketing-shell";
import { CopyCommand } from "@/components/landing/copy-command";
import { INSTALL_COMMAND } from "@/components/landing/content";
import { marketingContext } from "@/components/landing/mode";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Docs", description: "Guides for installing, using and operating LevantDeploy." };

/** Index of the guides that ship in the repository's docs/ folder. */
const GUIDES = [
  { icon: ServerCog, file: "docs/INSTALL.md", title: "Installation", text: "Requirements, the one-line installer and its flags, DNS, TLS, updates, backups and uninstall." },
  { icon: Rocket, file: "docs/USAGE.md", title: "Using LevantDeploy", text: "Projects, Git & GitHub, deployments and previews, environment variables, logs, cron and teams." },
  { icon: Globe, file: "docs/DOMAINS.md", title: "Domains & HTTPS", text: "Platform domain, wildcard DNS, custom domains, redirects and certificates." },
  { icon: Database, file: "docs/BASE-SPEC.md", title: "Backend", text: "How each project's backend (database, auth, REST, realtime, storage, functions, Studio) is run and limited." },
  { icon: BookOpen, file: "docs/SPEC.md", title: "Platform specification", text: "Architecture, data model, API and security model of the control plane." },
];

export default async function DocsPage() {
  const { mode, signedIn } = await marketingContext();
  return (
    <MarketingShell mode={mode} signedIn={signedIn}>
      <PageHero eyebrow="Docs" title="Documentation" text="The guides ship with the source in the docs/ folder of the repository. Start with the installer, then deploy your first project." />
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GUIDES.map((g, i) => (
            <div key={g.file} className="rounded-xl border border-border bg-surface p-6" data-reveal style={{ ["--lf-delay" as string]: `${(i % 3) * 70}ms` }}>
              <g.icon className="h-5 w-5 text-accent" />
              <h2 className="mt-4 text-[15px] font-semibold">{g.title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{g.text}</p>
              <p className="mt-4 font-mono text-[12px] text-subtle">{g.file}</p>
            </div>
          ))}
        </div>

        <div className="mt-16 grid gap-8 lg:grid-cols-2">
          <div data-reveal>
            <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <ServerCog className="h-5 w-5" /> Install on a server
            </h2>
            <p className="mt-2 text-[13px] text-muted">Run as root on Ubuntu 22.04/24.04 or Debian 12. Without flags the installer asks interactively.</p>
            <CopyCommand className="mt-4" command={INSTALL_COMMAND} />
          </div>
          <div data-reveal>
            <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Terminal className="h-5 w-5" /> Install the CLI
            </h2>
            <p className="mt-2 text-[13px] text-muted">The CLI is served by your own server; replace the host with your dashboard host.</p>
            <CopyCommand className="mt-4" command="npm i -g https://deploy.example.com/api/cli/levant.tgz" />
            <CopyCommand className="mt-2" command="levant login && levant deploy" />
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
