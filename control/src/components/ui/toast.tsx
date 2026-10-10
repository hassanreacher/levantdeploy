"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; title: string; description?: string };
type ToastFn = ((t: { title: string; description?: string; kind?: ToastKind }) => void) & {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
};

const Ctx = createContext<ToastFn | null>(null);

/** const toast = useToast(); toast.success("Saved"); toast.error("Failed", err.message) */
export function useToast(): ToastFn {
  const t = useContext(Ctx);
  if (!t) throw new Error("useToast must be used inside <ToastProvider>");
  return t;
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: { title: string; description?: string; kind?: ToastKind }) => {
      const id = ++seq;
      setItems((l) => [...l.slice(-3), { id, kind: t.kind ?? "info", title: t.title, description: t.description }]);
      setTimeout(() => dismiss(id), t.kind === "error" ? 7000 : 4000);
    },
    [dismiss],
  );
  const fn = Object.assign(push, {
    success: (title: string, description?: string) => push({ title, description, kind: "success" }),
    error: (title: string, description?: string) => push({ title, description, kind: "error" }),
    info: (title: string, description?: string) => push({ title, description, kind: "info" }),
  }) as ToastFn;
  return (
    <Ctx.Provider value={fn}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto flex animate-slide-up items-start gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-pop" role="status">
            {t.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            ) : t.kind === "error" ? (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-[13px] font-medium text-fg")}>{t.title}</p>
              {t.description && <p className="mt-0.5 text-[13px] text-muted">{t.description}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
