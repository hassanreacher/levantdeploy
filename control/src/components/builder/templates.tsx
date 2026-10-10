"use client";

import { ArrowRight, Shuffle } from "lucide-react";
import type { Template } from "@/lib/builder-ui/types";
import { SectionPreview } from "./section-preview";

/** Map a template to a representative wireframe when it has no thumbnail. */
function previewFor(t: Template): string {
  const s = `${t.id} ${t.name} ${t.tags?.join(" ") ?? ""}`.toLowerCase();
  if (/dash|admin|crm/.test(s)) return "stats";
  if (/store|shop|commerce/.test(s)) return "gallery";
  if (/blog|content/.test(s)) return "blog-list";
  if (/landing|saas|marketing/.test(s)) return "pricing";
  if (/auth|portal/.test(s)) return "auth-forms";
  if (/portfolio/.test(s)) return "team";
  return "hero";
}

export function TemplateCard({ t, onUse, disabled }: { t: Template; onUse: () => void; disabled?: boolean }) {
  return (
    <button onClick={onUse} disabled={disabled} className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface text-left transition-colors hover:border-border-strong disabled:opacity-60" data-testid="template-card">
      <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-bg-subtle">
        {t.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
        ) : (
          <SectionPreview id={previewFor(t)} className="h-full w-full p-3 transition-transform duration-300 group-hover:scale-[1.03]" />
        )}
        {t.kind === "remix" && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted">
            <Shuffle className="h-3 w-3" /> Remix
          </span>
        )}
      </div>
      <div className="flex flex-1 items-start gap-2 p-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium">{t.name}</p>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{t.description}</p>
        </div>
        <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
      </div>
    </button>
  );
}
