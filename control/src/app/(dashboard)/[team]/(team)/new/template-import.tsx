"use client";

import { LayoutTemplate } from "lucide-react";
import { Card, EmptyState } from "@/components/ui";
import { presetById } from "@/lib/build/types";
import type { Selection, Template } from "./types";

export function TemplateImport({ templates, onSelect }: { templates: Template[]; onSelect: (s: Selection) => void }) {
  if (!templates.length) {
    return <EmptyState icon={<LayoutTemplate className="h-5 w-5" />} title="No templates on this server" description="Templates come from the examples/ folder shipped with LevantDeploy." />;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((t) => {
        const p = presetById(t.framework);
        return (
          <button key={t.id} type="button" className="text-left" onClick={() => onSelect({ kind: "template", template: t })}>
            <Card interactive className="flex h-full items-start gap-3 p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 font-mono text-xs font-semibold text-fg">{p?.glyph ?? "··"}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">{t.name}</span>
                <span className="block text-[13px] text-muted">{t.frameworkName}</span>
                {t.description && <span className="mt-1 line-clamp-2 block text-xs text-subtle">{t.description}</span>}
              </span>
            </Card>
          </button>
        );
      })}
    </div>
  );
}
