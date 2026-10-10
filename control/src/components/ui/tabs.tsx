"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NavTab = { href: string; label: ReactNode; /** match only exact path */ exact?: boolean };

/** Route tabs with an underline indicator (used for project / team sub-navigation). */
export function NavTabs({ tabs, className }: { tabs: NavTab[]; className?: string }) {
  const pathname = usePathname();
  const isActive = (t: NavTab) => (t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/"));
  // the most specific matching tab wins
  const active = tabs.filter(isActive).sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <nav className={cn("-mb-px flex gap-1 overflow-x-auto", className)} aria-label="Tabs">
      {tabs.map((t) => {
        const on = active?.href === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "relative whitespace-nowrap rounded-md px-3 py-3 text-[13px] transition-colors",
              on ? "text-fg" : "text-muted hover:text-fg",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full",
              on ? "after:bg-fg" : "after:bg-transparent",
            )}
          >
            <span className="rounded-md px-0.5 py-1">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** In-page segmented tabs (local state). */
export function Tabs<T extends string>({
  tabs,
  value,
  defaultValue,
  onValueChange,
  className,
}: {
  tabs: { value: T; label: ReactNode }[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (v: T) => void;
  className?: string;
}) {
  const [inner, setInner] = useState<T | undefined>(defaultValue ?? tabs[0]?.value);
  const cur = value ?? inner;
  return (
    <div role="tablist" className={cn("inline-flex items-center gap-0.5 rounded-md border border-border bg-bg-subtle p-0.5", className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={cur === t.value}
          onClick={() => {
            setInner(t.value);
            onValueChange?.(t.value);
          }}
          className={cn(
            "h-7 rounded px-3 text-[13px] font-medium transition-colors",
            cur === t.value ? "bg-surface-2 text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
