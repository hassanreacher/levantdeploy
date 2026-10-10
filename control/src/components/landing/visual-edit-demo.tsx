"use client";

import { useEffect, useState } from "react";
import { GripVertical, MousePointer2, Type, Palette, Check, LayoutPanelTop } from "lucide-react";
import { cn } from "@/lib/utils";
import { useInView, useReducedMotion } from "./use-motion";

/**
 * Animated mock of the Builder's visual editor: select an element, change its text inline, change a style in the
 * inspector, drag a section above another — every change becomes a commit. Purely illustrative (no real editor).
 */
const FROM = "Fresh bread, every day";
const TO = "Baked at sunrise.";

// step: 0 idle · 1 hover title · 2 selected · 3 typing · 4 style · 5 drag section · 6 saved
const DURATIONS = [900, 900, 900, 1900, 1500, 1700, 2600];
const CURSOR: [number, number][] = [
  [78, 78],
  [30, 30],
  [30, 30],
  [44, 31],
  [88, 62],
  [8, 80],
  [8, 62],
];

export function VisualEditDemo({ className }: { className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(6);
      setTyped(TO.length);
      return;
    }
    if (!inView) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % DURATIONS.length), DURATIONS[step]);
    return () => clearTimeout(t);
  }, [step, inView, reduced]);

  useEffect(() => {
    if (reduced) return;
    if (step === 0) setTyped(0);
    if (step !== 3) return;
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      setTyped(i);
      if (i >= TO.length) clearInterval(id);
    }, 70);
    return () => clearInterval(id);
  }, [step, reduced]);

  const title = step >= 3 ? TO.slice(0, typed) || " " : FROM;
  const selected = step >= 2 && step <= 4;
  const styled = step >= 4;
  const swapped = step >= 5;
  const [cx, cy] = CURSOR[step];

  return (
    <div ref={ref} className={cn("overflow-hidden rounded-xl border border-border bg-surface shadow-pop", className)} role="img" aria-label="Visual editor demo: selecting a heading, editing its text, changing the button colour and dragging the reviews section above the menu">
      {/* editor toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[12px]">
        <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        <span className="ml-2 hidden truncate rounded-md border border-border bg-bg px-2 py-0.5 font-mono text-[11px] text-subtle sm:block">preview · bakery</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
          <MousePointer2 className="h-3 w-3" /> Visual edit
        </span>
      </div>
      <div className="grid sm:grid-cols-[1fr_190px]">
        {/* the "website" */}
        <div className="relative h-[330px] overflow-hidden bg-bg" aria-hidden>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-[12px] font-semibold">Maison Pain</span>
            <span className="flex gap-3 text-[10px] text-subtle">
              <span>Menu</span>
              <span>Order</span>
              <span>Visit</span>
            </span>
          </div>
          <div className="px-4 pt-5">
            <div className={cn("relative inline-block rounded px-1 transition-all", step === 1 && "outline outline-1 outline-accent/50", selected && "outline outline-2 outline-accent")}>
              {selected && (
                <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-accent px-1.5 py-px font-mono text-[9.5px] text-accent-fg">h1 · app/page.tsx:14</span>
              )}
              <span className="text-[20px] font-semibold tracking-tight sm:text-[22px]">
                {title}
                {step === 3 && <span className="ml-px inline-block h-5 w-px animate-pulse2 bg-accent align-middle" />}
              </span>
            </div>
            <div className="mt-2 space-y-1.5">
              <div className="h-1.5 w-3/4 rounded-full bg-surface-2" />
              <div className="h-1.5 w-1/2 rounded-full bg-surface-2" />
            </div>
            <span className={cn("mt-3 inline-flex h-7 items-center rounded-md px-3 text-[11px] font-medium transition-colors duration-500", styled ? "bg-accent text-accent-fg" : "bg-fg text-bg")}>Order for pickup</span>
          </div>
          {/* two sections that swap places */}
          <div className="relative mx-4 mt-4 h-[140px]">
            <Section label="Menu" top={swapped ? 72 : 0} dragging={step === 5}>
              <div className="grid grid-cols-3 gap-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-7 rounded bg-surface-2" />
                ))}
              </div>
            </Section>
            <Section label="Reviews" top={swapped ? 0 : 72} lifted={step === 5}>
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-surface-2" />
                <div className="h-1.5 flex-1 rounded-full bg-surface-2" />
                <span className="text-[10px] text-warning">★★★★★</span>
              </div>
            </Section>
          </div>
          {/* cursor */}
          <MousePointer2
            className="pointer-events-none absolute h-4 w-4 fill-fg text-bg drop-shadow transition-all duration-700 ease-out motion-reduce:hidden"
            style={{ left: `${cx}%`, top: `${cy}%` }}
          />
          {/* toast */}
          <div className={cn("absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-pop transition-all duration-300", step === 6 ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0")}>
            <Check className="h-3 w-3 text-success" /> Saved · commit <span className="font-mono">3f2a9c1</span>
          </div>
        </div>

        {/* inspector */}
        <div className="border-t border-border p-3 text-[11.5px] sm:border-l sm:border-t-0" aria-hidden>
          <p className="mb-2 font-medium text-fg">Inspector</p>
          <div className={cn("space-y-3 transition-opacity", selected || step >= 5 ? "opacity-100" : "opacity-40")}>
            <div>
              <p className="mb-1 flex items-center gap-1 text-subtle">
                <Type className="h-3 w-3" /> Text
              </p>
              <div className={cn("truncate rounded border bg-bg px-2 py-1", step === 3 ? "border-accent" : "border-border")}>{step >= 3 ? TO.slice(0, typed) || "…" : FROM}</div>
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1 text-subtle">
                <Palette className="h-3 w-3" /> Button colour
              </p>
              <div className="flex gap-1.5">
                <span className={cn("h-5 w-5 rounded-full border bg-fg", !styled ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : "border-border")} />
                <span className={cn("h-5 w-5 rounded-full bg-accent", styled && "ring-2 ring-accent ring-offset-1 ring-offset-surface")} />
                <span className="h-5 w-5 rounded-full bg-success" />
                <span className="h-5 w-5 rounded-full bg-warning" />
              </div>
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1 text-subtle">
                <LayoutPanelTop className="h-3 w-3" /> Sections
              </p>
              <ul className="space-y-1">
                {(swapped ? ["Hero", "Reviews", "Menu", "Footer"] : ["Hero", "Menu", "Reviews", "Footer"]).map((s) => (
                  <li key={s} className={cn("flex items-center gap-1 rounded border px-1.5 py-0.5", s === "Reviews" && step === 5 ? "border-accent bg-accent/10" : "border-border")}>
                    <GripVertical className="h-3 w-3 text-subtle" /> {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, top, children, lifted, dragging }: { label: string; top: number; children: React.ReactNode; lifted?: boolean; dragging?: boolean }) {
  return (
    <div
      className={cn(
        "absolute inset-x-0 h-[64px] rounded-lg border bg-surface p-2 transition-all duration-700 ease-out",
        lifted ? "z-10 scale-[1.02] border-accent shadow-pop" : "border-border",
        dragging && "opacity-70",
      )}
      style={{ top }}
    >
      <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-muted">
        <GripVertical className="h-3 w-3 text-subtle" /> {label}
      </p>
      {children}
    </div>
  );
}
