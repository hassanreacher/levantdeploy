"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { PROMPT_SUGGESTIONS, savePending } from "@/lib/builder-ui/prompts";

/**
 * Landing-page CTA (usable on `/` by the landing owner): "What do you want to build?" prompt for signed-out visitors.
 * Submitting stores the prompt locally and sends the visitor to sign-up; after registration the team Overview /
 * Build page picks the prompt up and starts building automatically (see takePending()).
 *
 *   import { BuilderPromptHero } from "@/components/builder/builder-prompt-hero";
 *   <BuilderPromptHero signUpHref={mode === "closed" ? "/login" : "/register"} />
 */
export function BuilderPromptHero({
  signUpHref = "/register",
  title = "What do you want to build?",
  subtitle = "Describe an app in plain words. AI agents build it — frontend, database, auth — and you publish it in one click.",
  className,
  showHeading = true,
}: {
  signUpHref?: string;
  title?: string;
  subtitle?: string;
  className?: string;
  showHeading?: boolean;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 88), 240)}px`;
  }, [prompt]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const p = prompt.trim();
    if (!p) return ta.current?.focus();
    savePending({ prompt: p });
    router.push(signUpHref);
  };

  return (
    <div className={cn("mx-auto w-full max-w-2xl", className)} data-testid="builder-prompt-hero">
      {showHeading && (
        <div className="mb-6 text-center">
          <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-muted">
            <Sparkles className="h-3.5 w-3.5 text-accent" /> AI app builder
          </span>
          <h2 className="text-[30px] font-semibold leading-tight tracking-tight sm:text-[40px]">{title}</h2>
          <p className="mx-auto mt-3 max-w-xl text-[15px] text-muted">{subtitle}</p>
        </div>
      )}
      <form onSubmit={submit} className="rounded-2xl border border-border bg-surface shadow-[0_16px_48px_-24px_rgb(var(--accent)/0.35)] transition-colors focus-within:border-border-strong">
        <textarea
          ref={ta}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          maxLength={4000}
          placeholder="A booking site for my barbershop with online payments…"
          aria-label="What do you want to build?"
          className="block w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-2 px-3 pb-3">
          <span className="text-[12px] text-subtle">Free to start · no credit card</span>
          <button type="submit" disabled={!prompt.trim()} aria-label="Start building" className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
            Build it <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {PROMPT_SUGGESTIONS.slice(0, 4).map((s) => (
          <button key={s.label} type="button" onClick={() => (setPrompt(s.prompt), ta.current?.focus())} className="rounded-full border border-border px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:border-border-strong hover:text-fg">
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
