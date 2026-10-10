import type { ReactNode } from "react";
import { Construction } from "lucide-react";
import { PageBody, PageHeader } from "./page-header";

/**
 * Placeholder for pages another area fills in. Replace the whole page.tsx when you implement it.
 *   <AreaPlaceholder title="Domains" area="runtime" description="…" />
 */
export function AreaPlaceholder({ title, area, description, children }: { title: string; area: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <PageBody>
        <div className="grid-bg flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-20 text-center">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-muted">
            <Construction className="h-5 w-5" />
          </div>
          <h3 className="text-[15px] font-semibold">Coming from the {area} agent</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted">
            This page is a placeholder created by the foundation. The <span className="font-mono text-fg">{area}</span> area owns it.
          </p>
          {children && <div className="mt-6 w-full max-w-2xl text-left">{children}</div>}
        </div>
      </PageBody>
    </>
  );
}
