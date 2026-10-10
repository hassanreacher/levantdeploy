"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Check, ShieldCheck, Sparkles, User, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useInView, useReducedMotion } from "./use-motion";

/**
 * Mock AI-agent conversation: question → diagnosis with log evidence → approval card → the agent applies the fix.
 * Steps advance on a timer while visible; reduced motion shows the final state.
 */
const FINAL = 6;

export function AgentDemo({ className }: { className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const [cycle, setCycle] = useState(0);
  const played = useRef(-1);

  useEffect(() => {
    if (reduced) {
      setStep(FINAL);
      return;
    }
    if (!inView) return;
    const timers: number[] = [];
    if (played.current === cycle) {
      // already played this cycle (scrolled away and back): keep the final state, loop later
      timers.push(window.setTimeout(() => setCycle((c) => c + 1), 5000));
      return () => timers.forEach(clearTimeout);
    }
    const delays = [300, 900, 1300, 1500, 1700, 1300];
    let t = 0;
    setStep(0);
    delays.forEach((d, i) => timers.push(window.setTimeout(() => setStep(i + 1), (t += d))));
    timers.push(window.setTimeout(() => (played.current = cycle), t)); // completed: re-entering the viewport won't restart it
    timers.push(window.setTimeout(() => setCycle((c) => c + 1), t + 5000));
    return () => {
      timers.forEach(clearTimeout);
      setStep(FINAL); // interrupted mid-play → show the complete conversation
    };
  }, [inView, reduced, cycle]);

  return (
    <div ref={ref} className={cn("flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Sparkles className="h-4 w-4 text-accent" /> Agent · storefront
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
          <ShieldCheck className="h-3 w-3" /> approval required
        </span>
      </div>
      <div className="flex min-h-[392px] flex-col gap-3 p-4 text-[13px]" aria-live="off">
        {step >= 1 && (
          <Msg who="user">Why did the last production deploy fail?</Msg>
        )}
        {step >= 2 && (
          <Msg who="agent">
            Deployment <span className="font-mono text-fg">#127</span> crashed on start. The runtime log shows:
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-bg-subtle p-2 font-mono text-[11.5px] leading-5 text-danger">
              Error: DATABASE_URL is not defined{"\n"}    at prisma/client.ts:4
            </pre>
            <span className="mt-2 block">
              It exists in <span className="font-mono text-fg">Preview</span> but not in <span className="font-mono text-fg">Production</span>. I can copy it and redeploy.
            </span>
          </Msg>
        )}
        {step >= 3 && (
          <div className="ml-8 animate-scale-in rounded-lg border border-border-strong bg-bg-subtle p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Proposed actions</p>
            <ul className="mt-2 space-y-1.5 font-mono text-[12px] text-fg">
              <li className="flex gap-2">
                <span className="text-accent">1</span> env.set DATABASE_URL → Production
              </li>
              <li className="flex gap-2">
                <span className="text-accent">2</span> deployment.redeploy #127
              </li>
            </ul>
            <div className="mt-3 flex gap-2">
              <span
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-all",
                  step >= 4 ? "bg-success/15 text-success" : "bg-fg text-bg",
                  step === 3 && "ring-2 ring-accent/60 ring-offset-2 ring-offset-bg-subtle",
                )}
              >
                <Check className="h-3.5 w-3.5" /> {step >= 4 ? "Approved" : "Approve"}
              </span>
              {step < 4 && (
                <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-muted">
                  <X className="h-3.5 w-3.5" /> Reject
                </span>
              )}
            </div>
          </div>
        )}
        {step >= 5 && (
          <Msg who="agent">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse2 rounded-full bg-warning" />
            Set <span className="font-mono text-fg">DATABASE_URL</span> · redeploying #128…
          </Msg>
        )}
        {step >= 6 && (
          <Msg who="agent">
            <span className="mr-2 inline-block h-2 w-2 rounded-full bg-success" />
            <span className="text-fg">#128 is Ready</span> — health check passed, traffic switched. Both actions are in the audit log.
          </Msg>
        )}
      </div>
    </div>
  );
}

function Msg({ who, children }: { who: "user" | "agent"; children: React.ReactNode }) {
  return (
    <div className="flex animate-slide-up gap-2.5">
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", who === "agent" ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-surface-2 text-muted")}>
        {who === "agent" ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </span>
      <div className={cn("min-w-0 flex-1 leading-relaxed", who === "user" ? "text-fg" : "text-muted")}>{children}</div>
    </div>
  );
}
