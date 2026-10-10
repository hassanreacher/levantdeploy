import type { Metadata } from "next";
import { Check, Minus } from "lucide-react";
import { MarketingShell, PageHero } from "@/components/landing/marketing-shell";
import { PricingCards } from "@/components/landing/pricing-cards";
import { COMPARISON, formatPrice, getPublicPlans } from "@/components/landing/plans";
import { primaryCta } from "@/components/landing/site-chrome";
import { marketingContext } from "@/components/landing/mode";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pricing", description: "Plans for the AI Builder, deployments and the built-in backend: Hobby, Pro and Team." };

export default async function PricingPage() {
  const [{ mode, signedIn }, { plans, source }] = await Promise.all([marketingContext(), getPublicPlans()]);
  const primary = primaryCta(mode);
  return (
    <MarketingShell mode={mode} signedIn={signedIn}>
      <PageHero
        eyebrow="Pricing"
        title="Simple plans for every project."
        text="Each plan covers AI Builder credits, deployments and the built-in backend. Plans and limits are defined by the operator of this server — there is no automatic billing."
      />
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <PricingCards plans={plans} ctaHref={signedIn ? "/" : primary.href} />
        {source === "default" && <p className="mt-4 text-center text-[12px] text-subtle">Default plans shown.</p>}
      </section>

      <section className="border-t border-border bg-bg-subtle/60">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight" data-reveal>
            Compare plans
          </h2>
          <div className="mt-8 overflow-x-auto rounded-xl border border-border bg-bg" data-reveal>
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="w-[40%] px-4 py-3 font-medium text-muted">
                    <span className="sr-only">Limit</span>
                  </th>
                  {plans.map((p) => (
                    <th key={p.slug} scope="col" className={cn("px-4 py-3 font-semibold", p.highlight && "text-accent")}>
                      {p.name}
                      <span className="block text-[12px] font-normal text-muted">
                        {formatPrice(p)}
                        {p.priceMonthly !== null && " / month"}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              {COMPARISON.map((g) => (
                <tbody key={g.group}>
                  <tr>
                    <th colSpan={plans.length + 1} scope="colgroup" className="bg-surface px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-subtle">
                      {g.group}
                    </th>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.label} className="border-t border-border">
                      <th scope="row" className="px-4 py-2.5 font-normal text-muted">
                        {r.label}
                      </th>
                      {plans.map((p) => {
                        const v = r.value(p.limits);
                        return (
                          <td key={p.slug} className="px-4 py-2.5 text-fg">
                            {v === true ? (
                              <Check className="h-4 w-4 text-success" aria-label="Included" />
                            ) : v === false ? (
                              <Minus className="h-4 w-4 text-subtle" aria-label="Not included" />
                            ) : (
                              v
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <p className="mt-4 text-[12px] text-subtle">
            One Builder credit = one message to the AI agents; visual edits, previews and publishing are free. Hard limits (projects, members, deployments per day, functions) are checked on creation. Usage limits (bandwidth, egress, database size, MAU) are
            metered monthly with warnings at 80 % and 100 %.
          </p>
        </div>
      </section>
    </MarketingShell>
  );
}
