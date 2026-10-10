"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { SETTINGS_SECTIONS } from "./sections";

/** Left column on desktop, horizontal scroller on phones. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Platform settings" className="-mx-4 shrink-0 overflow-x-auto px-4 md:mx-0 md:w-48 md:overflow-visible md:px-0">
      <ul className="flex gap-1 md:sticky md:top-20 md:flex-col">
        {SETTINGS_SECTIONS.map((s) => {
          const on = s.href === "/settings" ? pathname === s.href : pathname === s.href || pathname.startsWith(s.href + "/");
          return (
            <li key={s.href}>
              <Link
                href={s.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-md px-3 py-2 text-[13px] transition-colors",
                  on ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
