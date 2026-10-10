"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Click-to-open menu. `trigger` receives an `open` flag. */
export function Dropdown({
  trigger,
  children,
  align = "start",
  className,
  width = 220,
}: {
  trigger: (open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  className?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative inline-flex">
      <div onClick={() => setOpen((o) => !o)} className="inline-flex">
        {trigger(open)}
      </div>
      {open && (
        <div
          style={{ width }}
          className={cn(
            "absolute top-full z-40 mt-1.5 animate-scale-in rounded-lg border border-border bg-surface p-1 shadow-pop",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
          role="menu"
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

const itemClass =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50";

export function DropdownItem({ children, onClick, href, danger, icon, disabled }: { children: ReactNode; onClick?: () => void; href?: string; danger?: boolean; icon?: ReactNode; disabled?: boolean }) {
  const cls = cn(itemClass, danger && "text-danger hover:text-danger");
  if (href)
    return (
      <Link href={href} className={cls} role="menuitem" onClick={onClick}>
        {icon}
        {children}
      </Link>
    );
  return (
    <button type="button" className={cls} role="menuitem" onClick={onClick} disabled={disabled}>
      {icon}
      {children}
    </button>
  );
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-subtle">{children}</div>;
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
