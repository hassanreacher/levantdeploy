import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPrice, type PublicPlan } from "./plans";

export function PricingCards({ plans, ctaHref, compact }: { plans: PublicPlan[]; ctaHref: string; compact?: boolean }) {
  return (
    <div className={cn("grid gap-4", plans.length >= 3 ? "lg:grid-cols-3" : "md:grid-cols-2", plans.length === 4 && "xl:grid-cols-4")}>
      {plans.map((p, i) => (
        <div
          key={p.slug}
          data-reveal
          style={{ ["--lf-delay" as string]: `${i * 80}ms` }}
          className={cn(
            "relative flex flex-col rounded-xl border bg-surface p-6",
            p.highlight ? "border-accent/60 shadow-[0_0_0_1px_rgb(var(--accent)/0.25),0_20px_60px_-20px_rgb(var(--accent)/0.35)]" : "border-border",
          )}
        >
          {p.highlight && (
            <span className="absolute -top-2.5 left-6 rounded-full border border-accent/50 bg-bg px-2 py-0.5 text-[11px] font-medium text-accent">Most popular</span>
          )}
          <h3 className="text-[15px] font-semibold">{p.name}</h3>
          <p className="mt-1 text-[13px] text-muted">{p.blurb}</p>
          <p className="mt-5 flex items-baseline gap-1">
            <span className="text-4xl font-semibold tracking-tight">{formatPrice(p)}</span>
            {p.priceMonthly !== null && <span className="text-[13px] text-muted">/ month</span>}
          </p>
          <Link
            href={ctaHref}
            className={cn(
              "mt-5 inline-flex h-10 items-center justify-center rounded-md text-sm font-medium transition-opacity hover:opacity-90",
              p.highlight ? "bg-fg text-bg" : "border border-border bg-bg text-fg hover:border-border-strong",
            )}
          >
            {p.priceMonthly === null ? "Contact the operator" : p.priceMonthly === 0 ? "Start for free" : `Choose ${p.name}`}
          </Link>
          <div className="mt-6 space-y-5 text-[13px]">
            <PlanList title="AI Builder" items={compact ? p.builder.slice(0, 2) : p.builder} />
            <PlanList title="Deployments" items={compact ? p.deploy.slice(0, 3) : p.deploy} />
            <PlanList title="Backend" items={compact ? p.backend.slice(0, 3) : p.backend} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-subtle">{title}</p>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it} className="flex gap-2 text-muted">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg" /> <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
