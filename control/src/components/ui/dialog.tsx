"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Modal dialog (portal, Esc / backdrop to close, focus trap-lite). */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input,textarea,select,button[data-autofocus]")?.focus(), 10);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
      <div className="fixed inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full animate-scale-in rounded-lg border border-border bg-surface shadow-pop",
          size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg",
        )}
      >
        <button onClick={onClose} className="absolute right-3 top-3 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
        {(title || description) && (
          <div className="p-6 pb-0">
            {title && <h2 className="pr-8 text-lg font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
          </div>
        )}
        {children && <div className="p-6">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 rounded-b-lg border-t border-border bg-bg-subtle px-6 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
