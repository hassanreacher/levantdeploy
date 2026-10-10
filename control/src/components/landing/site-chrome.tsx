import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { cn } from "@/lib/utils";

export type RegistrationMode = "setup" | "open" | "invite";

export function primaryCta(mode: RegistrationMode) {
  return mode === "setup"
    ? { href: "/register", label: "Set up your server" }
    : mode === "open"
      ? { href: "/register", label: "Start deploying" }
      : { href: "/login", label: "Log in to deploy" };
}

const NAV = [
  { href: "/#builder", label: "Builder" },
  { href: "/#platform", label: "Platform" },
  { href: "/#backend", label: "Backend" },
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader({ mode, signedIn }: { mode: RegistrationMode; signedIn?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-transparent bg-bg/70 backdrop-blur-md supports-[backdrop-filter]:bg-bg/55">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="LevantDeploy home" className="shrink-0">
          <Logo withText />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 text-[13px] lg:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-fg">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1.5 text-[13px]">
          {signedIn ? (
            <Link href="/" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 font-medium text-bg transition-opacity hover:opacity-90">
              Dashboard <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-fg">
                Log in
              </Link>
              {mode !== "invite" && (
                <Link href="/register" className="inline-flex h-8 items-center rounded-md bg-fg px-3 font-medium text-bg transition-opacity hover:opacity-90">
                  {mode === "setup" ? "Set up" : "Sign up"}
                </Link>
              )}
            </>
          )}
        </div>
      </div>
      {/* compact nav for small screens: horizontally scrollable inside its own row (never the page) */}
      <nav aria-label="Sections" className="no-scrollbar -mt-1 flex gap-1 overflow-x-auto px-3 pb-2 text-[13px] lg:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="shrink-0 rounded-md px-2.5 py-1 text-muted transition-colors hover:text-fg">
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  const cols = [
    {
      title: "Platform",
      links: [
        { href: "/#builder", label: "AI Builder" },
        { href: "/#platform", label: "Deployments" },
        { href: "/#backend", label: "Backend" },
        { href: "/#agent", label: "AI agent" },
        { href: "/#cli", label: "CLI" },
      ],
    },
    {
      title: "Product",
      links: [
        { href: "/features", label: "All features" },
        { href: "/pricing", label: "Pricing" },
        { href: "/#self-host", label: "Self-hosting" },
        { href: "/#faq", label: "FAQ" },
      ],
    },
    {
      title: "Resources",
      links: [
        { href: "/docs", label: "Documentation" },
        { href: "/login", label: "Log in" },
        { href: "/register", label: "Sign up" },
      ],
    },
  ];
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Logo withText />
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-muted">
            Describe it. We build it, host it, and give it a backend — on a server you own.
          </p>
          <ThemeToggle className="mt-5" />
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h2 className="text-[13px] font-medium text-fg">{c.title}</h2>
            <ul className="mt-3 space-y-2 text-[13px]">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-muted transition-colors hover:text-fg">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-[12px] text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Self-hosted with LevantDeploy. The backend engine (LevantBase) is built from open-source components; their licenses apply.</p>
          <p>Made for builders in the Levant and everywhere else.</p>
        </div>
      </div>
    </footer>
  );
}

export function SectionHeading({ eyebrow, title, text, className, center }: { eyebrow?: string; title: React.ReactNode; text?: React.ReactNode; className?: string; center?: boolean }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center", className)} data-reveal>
      {eyebrow && <p className="mb-3 font-mono text-[12px] uppercase tracking-[0.14em] text-accent">{eyebrow}</p>}
      <h2 className="text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{title}</h2>
      {text && <p className="mt-3 text-pretty text-[15px] leading-relaxed text-muted sm:text-base">{text}</p>}
    </div>
  );
}
