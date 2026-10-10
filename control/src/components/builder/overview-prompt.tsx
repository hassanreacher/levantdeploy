"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { builderApi } from "@/lib/builder-ui/api";
import { peekPending } from "@/lib/builder-ui/prompts";
import type { Credits, Template } from "@/lib/builder-ui/types";
import { PromptBox } from "./prompt-box";

/**
 * Team Overview entry point: compact "What do you want to build?" box. It also continues a prompt typed on the landing
 * page before sign-up (registration lands on the team Overview).
 */
export function BuilderOverviewPrompt({ team }: { team: string }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setPending(peekPending());
    const B = builderApi();
    B.templates().then(setTemplates, () => {});
    B.credits(team).then(setCredits, () => {});
  }, [team]);
  return (
    <section className="mb-8 rounded-xl border border-border bg-surface p-4 sm:p-5" aria-labelledby="ov-build" data-testid="overview-build">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent" />
        <h2 id="ov-build" className="text-[15px] font-semibold tracking-tight">
          What do you want to build?
        </h2>
        <Link href={`/${team}/build`} className="ml-auto inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
          Your apps <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <PromptBox mode="app" team={team} templates={templates} credits={credits} compact resumePending={pending} />
    </section>
  );
}
