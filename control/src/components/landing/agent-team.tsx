"use client";

import { useEffect, useState } from "react";
import { Check, ClipboardList, Code2, Palette, Rocket, ShieldCheck, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useInView, useReducedMotion } from "./use-motion";

/**
 * "How the AI builds": the agent team as a pipeline (plan → design → code → check → fix → publish) with a live-ish
 * event log and a provider router that falls back when a provider is rate-limited. Purely illustrative.
 */
const STEPS = [
  { icon: ClipboardList, role: "Planner", title: "Plan", log: "Planner · spec, 7 pages, data model: bookings, services, customers" },
  { icon: Palette, role: "Designer", title: "Design", log: "Designer · theme warm-neutral, Inter, radius 12, layout grid" },
  { icon: Code2, role: "Coders", title: "Code", log: "Coder ×3 · 24 files written · Backend agent: 3 tables + RLS, bucket \"photos\"" },
  { icon: ShieldCheck, role: "Reviewer", title: "Check", log: "Reviewer · tsc ✓ · lint ✓ · next build ✗ 1 error in app/book/page.tsx" },
  { icon: Wrench, role: "Fixer", title: "Fix", log: "Fixer · patched missing import · next build ✓ · preview has 0 runtime errors" },
  { icon: Rocket, role: "Judge", title: "Publish", log: "Judge · picked best of 2 candidates · published https://barber.example.com" },
];

const PROVIDERS = ["gemini", "groq", "openrouter", "mistral", "claude"];

export function AgentTeam({ className }: { className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(STEPS.length);
      return;
    }
    if (!inView) return;
    const id = window.setInterval(() => setStep((s) => (s >= STEPS.length + 2 ? 0 : s + 1)), 1300);
    return () => clearInterval(id);
  }, [inView, reduced]);

  const done = Math.min(step, STEPS.length);
  // the fallback happens while coding (step index 2): groq is rate-limited → router moves to openrouter
  const fallback = step >= 2 || reduced;
  const active = step < STEPS.length ? step : -1;

  return (
    <div ref={ref} className={cn("grid gap-6 lg:grid-cols-[1.6fr_1fr]", className)}>
      <div className="min-w-0 rounded-xl border border-border bg-surface p-5 sm:p-6">
        <ol className="relative grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Agent pipeline">
          {STEPS.map((s, i) => {
            const state = i < done ? "done" : i === active ? "active" : "todo";
            return (
              <li key={s.title} className="relative">
                <div
                  className={cn(
                    "flex h-full flex-col items-center gap-2 rounded-lg border px-2 py-3 text-center transition-all duration-500",
                    state === "done" && "border-border-strong bg-bg",
                    state === "active" && "border-accent/70 bg-accent/10 shadow-[0_0_24px_-6px_rgb(var(--accent)/0.6)]",
                    state === "todo" && "border-border bg-bg opacity-60",
                  )}
                >
                  <span className={cn("relative flex h-9 w-9 items-center justify-center rounded-full border", state === "active" ? "border-accent text-accent" : "border-border-strong text-fg")}>
                    {state === "done" ? <Check className="h-4 w-4 text-success" /> : <s.icon className="h-4 w-4" />}
                    {state === "active" && <span className="absolute inset-0 animate-ping rounded-full border border-accent/50 motion-reduce:hidden" />}
                  </span>
                  <span className="text-[13px] font-medium">{s.title}</span>
                  <span className="text-[11px] text-subtle">{s.role}</span>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-all duration-700" style={{ width: `${(done / STEPS.length) * 100}%` }} />
        </div>
        <div className="mt-4 min-h-[156px] space-y-1 rounded-lg border border-border bg-bg-subtle p-3 font-mono text-[11.5px] leading-5" aria-live="off">
          {STEPS.slice(0, Math.max(1, done + (active >= 0 ? 1 : 0))).slice(-6).map((s, i, arr) => (
            <p key={s.title} className={cn("truncate", i === arr.length - 1 && active >= 0 ? "text-fg" : "text-muted")}>
              <span className="text-subtle">›</span> {s.log}
            </p>
          ))}
        </div>
      </div>

      <div className="min-w-0 rounded-xl border border-border bg-surface p-5 sm:p-6">
        <p className="text-[13px] font-medium">Model router</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Every agent call goes through a router with health scores, rate-limit tracking and automatic fallback — the run resumes from the last completed step.</p>
        <ul className="mt-4 space-y-2 font-mono text-[12px]">
          {PROVIDERS.map((p) => {
            const limited = p === "groq" && step >= 2 && step < STEPS.length + 1;
            const serving = fallback ? p === "openrouter" : p === "groq";
            return (
              <li key={p} className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 transition-colors duration-500", serving ? "border-accent/60 bg-accent/10" : "border-border bg-bg")}>
                <span className="flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", limited ? "bg-warning" : serving ? "bg-accent" : "bg-success/70")} />
                  {p}
                </span>
                <span className="text-[11px] text-subtle">{limited ? "429 · cooling down" : serving ? (fallback ? "serving · fell back" : "serving") : "healthy"}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11.5px] text-subtle">Providers are configured by the server operator — free tiers and premium models both work.</p>
      </div>
    </div>
  );
}
