"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useInView, useReducedMotion } from "./use-motion";

type Line = { text: string; tone?: "fg" | "muted" | "subtle" | "success" | "accent"; delay: number };

const COMMAND = "levant deploy --prod";
const LINES: Line[] = [
  { text: "› Linked to acme/storefront (production)", tone: "subtle", delay: 350 },
  { text: "› Packing 214 files (1.8 MB, .gitignore respected)", tone: "muted", delay: 450 },
  { text: "› Uploaded in 1.2s · deployment #128 queued", tone: "muted", delay: 500 },
  { text: "› Detected Next.js 15 · Node 22 · npm", tone: "fg", delay: 600 },
  { text: "  npm ci                          ✓ 9.8s", tone: "muted", delay: 700 },
  { text: "  next build                      ✓ 27.4s", tone: "muted", delay: 900 },
  { text: "  image levant/storefront:k3x9q2m ✓ 3.1s", tone: "muted", delay: 600 },
  { text: "› Backend env injected: SUPABASE_URL, ANON_KEY", tone: "accent", delay: 500 },
  { text: "› Health check passed · switching traffic (0 dropped)", tone: "muted", delay: 700 },
  { text: "✓ Ready in 43s  https://storefront.example.com", tone: "success", delay: 600 },
];

const toneClass: Record<NonNullable<Line["tone"]>, string> = {
  fg: "text-fg",
  muted: "text-muted",
  subtle: "text-subtle",
  success: "text-success",
  accent: "text-accent",
};

/** Animated terminal: types the command, streams the build log, holds, loops. Static final state for reduced motion. */
export function TerminalDemo({ className }: { className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  const reduced = useReducedMotion();
  const [typed, setTyped] = useState(0);
  const [shown, setShown] = useState(0);
  const [cycle, setCycle] = useState(0);
  const played = useRef(-1);

  useEffect(() => {
    if (reduced) {
      setTyped(COMMAND.length);
      setShown(LINES.length);
      return;
    }
    if (!inView) return;
    let cancelled = false;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(() => !cancelled && fn(), ms));
    if (played.current === cycle) {
      at(4200, () => setCycle((c) => c + 1));
      return () => {
        cancelled = true;
        timers.forEach(clearTimeout);
      };
    }
    setTyped(0);
    setShown(0);
    let t = 400;
    for (let i = 1; i <= COMMAND.length; i++) at((t += 45 + (i % 4) * 12), () => setTyped(i));
    t += 300;
    LINES.forEach((l, i) => at((t += l.delay), () => setShown(i + 1)));
    at(t, () => (played.current = cycle)); // completed: re-entering the viewport won't restart it
    at(t + 4200, () => setCycle((c) => c + 1));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      setTyped(COMMAND.length); // interrupted mid-play → show the finished run
      setShown(LINES.length);
    };
  }, [inView, reduced, cycle]);

  const done = typed >= COMMAND.length;
  return (
    <div ref={ref} className={cn("overflow-hidden rounded-xl border border-border bg-surface shadow-pop", className)}>
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        <span className="ml-3 truncate font-mono text-[12px] text-subtle">~/storefront — zsh</span>
      </div>
      <div className="h-[408px] p-4 font-mono text-[11.5px] leading-6 sm:h-[312px] sm:p-5 sm:text-[12.5px]" role="img" aria-label={`Terminal running ${COMMAND}: the app is built and live in 43 seconds`}>
        <div className="whitespace-pre-wrap break-words text-fg">
          <span className="text-success">➜</span> <span className="text-accent">storefront</span> {COMMAND.slice(0, typed)}
          {!done && <span className="ml-px inline-block h-4 w-2 translate-y-0.5 animate-pulse2 bg-fg" />}
        </div>
        {LINES.slice(0, shown).map((l, i) => (
          <div key={i} className={cn("whitespace-pre-wrap break-words animate-fade-in", toneClass[l.tone ?? "muted"])}>
            {l.text}
          </div>
        ))}
        {done && shown < LINES.length && (
          <div className="text-subtle">
            <span className="inline-block animate-spin">⠋</span>
          </div>
        )}
      </div>
    </div>
  );
}
