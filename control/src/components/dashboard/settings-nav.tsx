"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Vercel-style settings side navigation (horizontal scroller on mobile). Exact match for the first (index) item. */
export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  const active = items
    .filter((i, idx) => (idx === 0 ? pathname === i.href : pathname === i.href || pathname.startsWith(i.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <nav aria-label="Settings" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={cn(
            "whitespace-nowrap rounded-md px-3 py-2 text-[13px] transition-colors",
            active?.href === i.href ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function SettingsShell({ nav, children }: { nav: { href: string; label: string }[]; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[200px_minmax(0,1fr)] md:gap-10">
      <aside className="min-w-0 md:sticky md:top-20 md:self-start">
        <SettingsNav items={nav} />
      </aside>
      <div className="min-w-0 max-w-3xl space-y-6">{children}</div>
    </div>
  );
}
