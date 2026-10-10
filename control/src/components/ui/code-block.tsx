import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/** Monospace block with a copy button. `prompt` adds a "$ " prefix (shell commands). */
export function CodeBlock({ code, title, className, prompt, wrap }: { code: string; title?: string; className?: string; prompt?: boolean; wrap?: boolean }) {
  return (
    <div className={cn("group relative overflow-hidden rounded-lg border border-border bg-bg-subtle", className)}>
      {title && <div className="border-b border-border px-4 py-2 font-mono text-xs text-muted">{title}</div>}
      <pre className={cn("overflow-x-auto p-4 pr-12 font-mono text-[13px] leading-relaxed text-fg", wrap && "whitespace-pre-wrap break-all")}>
        {prompt
          ? code.split("\n").map((l, i) => (
              <div key={i}>
                <span className="select-none text-subtle">$ </span>
                {l}
              </div>
            ))
          : code}
      </pre>
      <CopyButton value={code} className={cn("absolute right-2", title ? "top-11" : "top-2.5")} />
    </div>
  );
}

/** Inline code. */
export function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-fg">{children}</code>;
}
