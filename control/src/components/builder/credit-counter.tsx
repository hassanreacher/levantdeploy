"use client";

import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Credits } from "@/lib/builder-ui/types";

/** "3 of 5 messages left today" pill (plans: builder messages per day / month). */
export function CreditCounter({ credits, className, team }: { credits: Credits | null; className?: string; team?: string }) {
  if (!credits) return null;
  const dayLeft = credits.perDay != null ? Math.max(0, credits.perDay - credits.usedToday) : null;
  const monthLeft = credits.perMonth != null ? Math.max(0, credits.perMonth - credits.usedMonth) : null;
  const left = credits.remaining ?? (dayLeft != null && monthLeft != null ? Math.min(dayLeft, monthLeft) : (dayLeft ?? monthLeft));
  const label =
    left == null
      ? "Unlimited messages"
      : credits.perDay != null && left === dayLeft
        ? `${left} of ${credits.perDay} left today`
        : `${left} message${left === 1 ? "" : "s"} left`;
  const low = left != null && left <= 1;
  const title = [
    credits.plan ? `${credits.plan} plan` : null,
    credits.perDay != null ? `Today: ${credits.usedToday}/${credits.perDay}` : null,
    credits.perMonth != null ? `This month: ${credits.usedMonth}/${credits.perMonth}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <>
      <Coins className="h-3 w-3" />
      {label}
    </>
  );
  const cls = cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11.5px]", low ? "text-warning" : "text-subtle", className);
  return team && low ? (
    <a href={`/${team}/settings/plan`} className={cn(cls, "hover:underline")} title={title} data-testid="credit-counter">
      {body}
    </a>
  ) : (
    <span className={cls} title={title} data-testid="credit-counter">
      {body}
    </span>
  );
}
