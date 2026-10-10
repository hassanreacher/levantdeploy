import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const inputClass =
  "h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg placeholder:text-subtle transition-colors hover:border-border-strong focus:border-fg/40 focus:outline-none focus:ring-2 focus:ring-fg/10 disabled:cursor-not-allowed disabled:opacity-60";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> & { invalid?: boolean; prefix?: ReactNode; suffix?: ReactNode };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, prefix, suffix, ...rest }, ref) {
  if (prefix || suffix) {
    return (
      <div
        className={cn(
          "flex h-9 w-full items-center rounded-md border border-border bg-bg text-sm transition-colors focus-within:border-fg/40 focus-within:ring-2 focus-within:ring-fg/10 hover:border-border-strong",
          invalid && "border-danger/70",
          className,
        )}
      >
        {prefix && <span className="flex h-full items-center border-r border-border px-3 text-muted">{prefix}</span>}
        <input ref={ref} className="h-full min-w-0 flex-1 bg-transparent px-3 text-fg placeholder:text-subtle focus:outline-none" {...rest} />
        {suffix && <span className="flex h-full items-center px-3 text-muted">{suffix}</span>}
      </div>
    );
  }
  return <input ref={ref} className={cn(inputClass, invalid && "border-danger/70 focus:ring-danger/20", className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { className, invalid, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(inputClass, "h-auto min-h-[80px] py-2", invalid && "border-danger/70", className)} {...rest} />;
});

export function Label({ children, htmlFor, className }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("mb-1.5 block text-[13px] font-medium text-muted", className)}>
      {children}
    </label>
  );
}

/** Label + control + hint/error. */
export function Field({ label, htmlFor, hint, error, children, className }: { label?: ReactNode; htmlFor?: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? <p className="mt-1.5 text-xs text-danger">{error}</p> : hint ? <p className="mt-1.5 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}
