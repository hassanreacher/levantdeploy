import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Crumb = { label: ReactNode; href?: string; icon?: ReactNode };

/** Slash-separated breadcrumbs (Vercel style). */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("flex min-w-0 items-center gap-1 text-sm", className)}>
      {items.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && (
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-border-strong" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M16.88 3.549L7.12 20.451" />
            </svg>
          )}
          {c.href ? (
            <Link href={c.href} className="flex min-w-0 items-center gap-2 truncate rounded-md px-1.5 py-1 font-medium text-fg transition-colors hover:bg-surface-2">
              {c.icon}
              <span className="truncate">{c.label}</span>
            </Link>
          ) : (
            <span className="flex min-w-0 items-center gap-2 truncate px-1.5 py-1 font-medium text-fg">
              {c.icon}
              <span className="truncate">{c.label}</span>
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
