"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Ctrl/⌘+K command palette (skeleton). Items come from the dashboard layout (teams, projects, pages)
 * plus anything a page registers with `useCommands([...])`.
 */
export type CommandItem = {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  href?: string;
  run?: () => void;
};

const OPEN_EVENT = "ld:command-palette";
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));

type Ctx = { register: (key: string, items: CommandItem[]) => void; unregister: (key: string) => void };
const PaletteCtx = createContext<Ctx | null>(null);

/** Register page-specific commands while the component is mounted. */
export function useCommands(items: CommandItem[]) {
  const ctx = useContext(PaletteCtx);
  const key = useRef(Math.random().toString(36).slice(2)).current;
  const sig = items.map((i) => i.id).join("|");
  useEffect(() => {
    ctx?.register(key, items);
    return () => ctx?.unregister(key);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * `searchUrl` (optional): GET `${searchUrl}?q=` → `{ items: CommandItem[] }` (href items only) merged under the static
 * results while typing (dashboard area: /api/v1/teams/:team/search finds deployments by id/commit/branch).
 */
export function CommandPaletteProvider({ items: baseItems, children, searchUrl }: { items: CommandItem[]; children: ReactNode; searchUrl?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [extra, setExtra] = useState<Record<string, CommandItem[]>>({});
  const [remote, setRemote] = useState<CommandItem[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const ctx = useMemo<Ctx>(
    () => ({
      register: (k, items) => setExtra((e) => ({ ...e, [k]: items })),
      unregister: (k) =>
        setExtra((e) => {
          const { [k]: _omit, ...rest } = e;
          return rest;
        }),
    }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const s = q.trim();
    if (!searchUrl || s.length < 2 || !open) {
      setRemote([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${searchUrl}?q=${encodeURIComponent(s)}`, { signal: ac.signal, credentials: "same-origin" });
        if (res.ok) setRemote((((await res.json()) as { items?: CommandItem[] }).items ?? []).filter((i) => i.href));
      } catch {}
    }, 150);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, searchUrl, open]);

  const all = useMemo(() => [...Object.values(extra).flat(), ...baseItems], [extra, baseItems]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    const local = all.filter((i) => `${i.label} ${i.group ?? ""} ${i.keywords ?? ""}`.toLowerCase().includes(s));
    const seen = new Set(local.map((i) => i.href ?? i.id));
    return [...local, ...remote.filter((i) => !seen.has(i.href ?? i.id))];
  }, [all, q, remote]);

  const run = (i: CommandItem | undefined) => {
    if (!i) return;
    setOpen(false);
    if (i.run) i.run();
    else if (i.href) router.push(i.href);
  };

  const groups = useMemo(() => {
    const m = new Map<string, CommandItem[]>();
    for (const i of filtered) {
      const g = i.group ?? "General";
      m.set(g, [...(m.get(g) ?? []), i]);
    }
    return [...m.entries()];
  }, [filtered]);

  let idx = -1;
  return (
    <PaletteCtx.Provider value={ctx}>
      {children}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[55] flex items-start justify-center p-4 pt-[14vh]">
            <div className="fixed inset-0 animate-fade-in bg-black/50" onClick={() => setOpen(false)} />
            <div className="relative w-full max-w-xl animate-scale-in overflow-hidden rounded-xl border border-border bg-surface shadow-pop" role="dialog" aria-label="Command menu">
              <div className="flex items-center gap-3 border-b border-border px-4">
                <Search className="h-4 w-4 text-subtle" />
                <input
                  ref={input}
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setSel(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSel((s) => Math.min(s + 1, filtered.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSel((s) => Math.max(s - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      run(filtered[sel]);
                    } else if (e.key === "Escape") setOpen(false);
                  }}
                  placeholder="Search projects, teams, pages, actions…"
                  className="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-subtle focus:outline-none"
                />
                <span className="kbd">Esc</span>
              </div>
              <div className="max-h-[360px] overflow-y-auto p-1.5">
                {filtered.length === 0 && <p className="px-3 py-8 text-center text-sm text-subtle">No results</p>}
                {groups.map(([g, items]) => (
                  <div key={g} className="mb-1">
                    <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-subtle">{g}</div>
                    {items.map((i) => {
                      idx++;
                      const my = idx;
                      return (
                        <button
                          key={i.id}
                          onMouseEnter={() => setSel(my)}
                          onClick={() => run(i)}
                          className={cn("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[13px]", sel === my ? "bg-surface-2 text-fg" : "text-muted")}
                        >
                          <span className="flex h-4 w-4 items-center justify-center text-subtle">{i.icon ?? <ArrowRight className="h-3.5 w-3.5" />}</span>
                          <span className="flex-1 truncate">{i.label}</span>
                          {i.hint && <span className="text-[12px] text-subtle">{i.hint}</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </PaletteCtx.Provider>
  );
}

export function CommandTrigger({ className }: { className?: string }) {
  return (
    <button
      onClick={openCommandPalette}
      className={cn("hidden h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong hover:text-muted md:flex", className)}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="pr-6">Find…</span>
      <span className="kbd">Ctrl K</span>
    </button>
  );
}

/** Wide search field that opens the palette (team overview). */
export function SearchField({ placeholder = "Search…", className }: { placeholder?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className={cn("flex h-9 w-full items-center gap-2 rounded-md border border-border bg-bg px-3 text-subtle transition-colors hover:border-border-strong", className)}
    >
      <Search className="h-4 w-4" />
      <span className="text-sm">{placeholder}</span>
      <span className="kbd ml-auto">Ctrl K</span>
    </button>
  );
}
