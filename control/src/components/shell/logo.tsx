import { cn } from "@/lib/utils";

/** LevantDeploy mark: an upward chevron stack ("deploy up") in a rounded square. */
export function Logo({ className, withText }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-fg" />
        <path d="M9 19.5 16 12.5l7 7" fill="none" className="stroke-bg" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.5 24h9" fill="none" className="stroke-bg" strokeWidth="2.6" strokeLinecap="round" opacity=".55" />
      </svg>
      {withText && <span className="text-[15px] font-semibold tracking-tight">LevantDeploy</span>}
    </span>
  );
}
