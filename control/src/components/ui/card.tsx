import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ children, className, interactive }: { children: ReactNode; className?: string; interactive?: boolean }) {
  return (
    <div className={cn("rounded-lg border border-border bg-surface", interactive && "transition-colors hover:border-border-strong", className)}>{children}</div>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 p-5 pb-0", className)}>
      <div className="min-w-0">
        <h3 className="text-base font-semibold tracking-tight text-fg">{title}</h3>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

/** Vercel-style settings card footer: hint on the left, action on the right. */
export function CardFooter({ children, hint, className }: { children?: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-[52px] items-center justify-between gap-4 rounded-b-lg border-t border-border bg-bg-subtle px-5 py-2.5", className)}>
      <div className="text-[13px] text-muted">{hint}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
