import Link from "next/link";
import { ArrowRight, Database, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { BaseProjectDTO } from "@/lib/base-ui/shared";
import { BaseStatusBadge } from "./common";

/** Project overview: the project's backend (status + link), or a prompt to add one. */
export function BackendCard({ teamSlug, projectSlug, base, canAdd }: { teamSlug: string; projectSlug: string; base: BaseProjectDTO | null; canAdd: boolean }) {
  const href = `/${teamSlug}/${projectSlug}/backend`;
  if (!base) {
    if (!canAdd) return null;
    return (
      <Link href={href} className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-[13px] text-muted transition-colors hover:border-border-strong hover:text-fg">
        <Plus className="h-4 w-4 shrink-0" />
        <span className="flex-1">Add a backend — Postgres, Auth, REST API, Realtime, Storage and Edge Functions for this project.</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0" />
      </Link>
    );
  }
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Backend</h2>
          <p className="text-[13px] text-muted">LevantBase project connected to this app.</p>
        </div>
        <Link href={href} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg">
          Open <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Link href={href}>
        <Card interactive className="flex flex-wrap items-center gap-4 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle text-muted">
            <Database className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{base.name}</span>
              <BaseStatusBadge status={base.status} />
            </div>
            <div className="truncate font-mono text-[12px] text-muted">{base.apiUrl}</div>
          </div>
          <div className="hidden text-right text-[12px] text-muted sm:block">
            <div>{base.region}</div>
            <div className="font-mono">{base.ref}</div>
          </div>
        </Card>
      </Link>
    </section>
  );
}
