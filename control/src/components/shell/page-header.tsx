import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Big page title band (Vercel style): title + description left, actions right. */
export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("border-b border-border bg-bg", className)}>
      <div className="container-page flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:py-10">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight text-fg sm:text-[32px]">{title}</h1>
          {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Content wrapper used under PageHeader. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("container-page py-8", className)}>{children}</div>;
}
