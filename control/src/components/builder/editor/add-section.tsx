"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { SECTION_CATEGORIES, SECTION_LIBRARY, type SectionCategory } from "@/lib/builder-ui/sections";
import { elementLabel } from "@/lib/builder-ui/bridge";
import { useEditor } from "./context";
import { SectionPreview } from "../section-preview";

/** Component library: insert a pre-built section before/after the selected section. */
export function AddSectionDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ed = useEditor();
  const [cat, setCat] = useState<SectionCategory | "All">("All");
  const [position, setPosition] = useState<"before" | "after">("after");
  const [busy, setBusy] = useState<string | null>(null);
  const sel = ed.selection;
  const target = sel?.sectionSrc ?? sel?.src ?? null;
  const items = SECTION_LIBRARY.filter((s) => cat === "All" || s.category === cat);

  const insert = async (id: string, name: string) => {
    if (!target) return;
    setBusy(id);
    const ok = await ed.applyOps([{ op: "insert", target, position, component: id }], `Add ${name.toLowerCase()} section`);
    setBusy(null);
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a section" description={target ? `Inserted ${position} the selected ${sel?.sectionSrc ? "section" : elementLabel(sel!).toLowerCase()}. You can edit everything afterwards.` : "Select an element in the preview first."} size="lg">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs<SectionCategory | "All"> tabs={(["All", ...SECTION_CATEGORIES] as const).map((c) => ({ value: c, label: c }))} value={cat} onValueChange={setCat} />
        <div className="ml-auto">
          <Tabs<"before" | "after"> tabs={[{ value: "before", label: "Before" }, { value: "after", label: "After" }]} value={position} onValueChange={setPosition} />
        </div>
      </div>
      <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3" data-testid="section-library">
        {items.map((s) => (
          <button
            key={s.id}
            disabled={!target || !!busy}
            onClick={() => void insert(s.id, s.name)}
            className={cn("group overflow-hidden rounded-lg border border-border bg-bg-subtle text-left transition-colors hover:border-accent disabled:opacity-60", busy === s.id && "border-accent")}
          >
            <SectionPreview id={s.id} className="aspect-[16/10] w-full border-b border-border bg-surface transition-colors group-hover:bg-surface-2" />
            <div className="p-2.5">
              <p className="text-[13px] font-medium">{busy === s.id ? "Adding…" : s.name}</p>
              <p className="truncate text-[11.5px] text-subtle">{s.description}</p>
            </div>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
