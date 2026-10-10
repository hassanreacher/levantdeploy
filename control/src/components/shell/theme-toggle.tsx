"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export type ThemePref = "dark" | "light" | "system";
export const THEME_KEY = "ld-theme";

/** Inline script for <head>: applies the saved theme before paint (dark by default). */
export const themeScript = `(function(){try{var p=localStorage.getItem('${THEME_KEY}')||'dark';var t=p==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):p;var c=document.documentElement.classList;c.remove('dark','light');c.add(t);}catch(e){document.documentElement.classList.add('dark')}})();`;

export function applyTheme(p: ThemePref) {
  const t = p === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : p;
  const c = document.documentElement.classList;
  c.remove("dark", "light");
  c.add(t);
  try {
    localStorage.setItem(THEME_KEY, p);
  } catch {}
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>("dark");
  useEffect(() => {
    try {
      setPref((localStorage.getItem(THEME_KEY) as ThemePref) || "dark");
    } catch {}
  }, []);
  return [
    pref,
    (p) => {
      setPref(p);
      applyTheme(p);
    },
  ];
}

/** Segmented System / Light / Dark control. */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, set] = useTheme();
  const opts: { v: ThemePref; icon: React.ReactNode; label: string }[] = [
    { v: "system", icon: <Monitor className="h-3.5 w-3.5" />, label: "System" },
    { v: "light", icon: <Sun className="h-3.5 w-3.5" />, label: "Light" },
    { v: "dark", icon: <Moon className="h-3.5 w-3.5" />, label: "Dark" },
  ];
  return (
    <div className={cn("inline-flex items-center rounded-full border border-border p-0.5", className)} role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={pref === o.v}
          aria-label={o.label}
          title={o.label}
          data-theme-option={o.v}
          onClick={() => set(o.v)}
          className={cn("flex h-6 w-6 items-center justify-center rounded-full transition-colors", pref === o.v ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
