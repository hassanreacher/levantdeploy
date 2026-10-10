import { RevealObserver } from "./reveal-observer";
import { SiteFooter, SiteHeader, type RegistrationMode } from "./site-chrome";
import "./landing.css";

/** Chrome for the public marketing pages (/features, /pricing, /docs). */
export function MarketingShell({ mode, signedIn, children }: { mode: RegistrationMode; signedIn?: boolean; children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <RevealObserver />
      <SiteHeader mode={mode} signedIn={signedIn} />
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}

export function PageHero({ eyebrow, title, text, children }: { eyebrow: string; title: string; text: string; children?: React.ReactNode }) {
  return (
    <section className="relative isolate overflow-hidden border-b border-border">
      <div className="lf-hero-bg pointer-events-none absolute inset-0 -z-10 opacity-70" />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full grid-bg [mask-image:radial-gradient(ellipse_at_top,black_15%,transparent_70%)]" />
      <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6 sm:py-24">
        <p className="mb-3 font-mono text-[12px] uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
        <h1 className="lf-gradient-text mx-auto max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-[15px] leading-relaxed text-muted sm:text-lg">{text}</p>
        {children}
      </div>
    </section>
  );
}
