import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string; disabled?: boolean };

/** Native select, styled. Pass `options` or <option> children. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { options?: SelectOption[]; invalid?: boolean }>(function Select(
  { className, options, children, invalid, ...rest },
  ref,
) {
  return (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-border bg-bg pl-3 pr-8 text-sm text-fg transition-colors hover:border-border-strong focus:border-fg/40 focus:outline-none focus:ring-2 focus:ring-fg/10 disabled:opacity-60",
          invalid && "border-danger/70",
        )}
        {...rest}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
});
