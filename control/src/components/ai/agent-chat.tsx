"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowUp, Brain, ChevronRight, Info, Repeat2, Sparkles, Square, X } from "lucide-react";
import type { UiAction, UiBlock, UiMessage } from "@/lib/ai/types";
import { Button, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { ApprovalCard, ToolCard } from "./tool-card";
import type { AgentHandle, DraftBlock } from "./use-agent";

export function AgentAvatar({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent", className)}>
      <Sparkles className="h-3.5 w-3.5" />
    </div>
  );
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13px]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-subtle hover:text-muted">
        <Brain className="h-3.5 w-3.5" />
        {live ? "Thinking…" : "Thought process"}
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-muted">{text}</div>}
    </div>
  );
}

function Notice({ tone, text }: { tone: "info" | "warning" | "danger"; text: string }) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]", tone === "danger" ? "border-danger/30 bg-danger/5 text-danger" : tone === "warning" ? "border-warning/30 bg-warning/5 text-warning" : "border-border bg-surface text-muted")}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function Blocks({ blocks, actionsByToolUse, agent, live }: { blocks: (UiBlock | DraftBlock)[]; actionsByToolUse: Map<string, UiAction>; agent: AgentHandle; live?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${i}-${b.type}`;
        switch (b.type) {
          case "text":
            return b.text.trim() ? <Markdown key={key} text={b.text} /> : null;
          case "thinking":
            return b.text.trim() ? <Thinking key={key} text={b.text} live={live && i === blocks.length - 1} /> : null;
          case "tool_use": {
            const action = actionsByToolUse.get(b.id);
            return (
              <div key={key} className="space-y-2">
                <ToolCard name={b.name} input={b.input} action={action} streaming={live && !action} />
                {action?.requiresApproval && action.status === "PENDING_APPROVAL" && (
                  <ApprovalCard action={action} disabled={agent.busy} onApprove={(c) => agent.approve(action.id, c)} onReject={() => agent.reject(action.id)} />
                )}
              </div>
            );
          }
          case "fallback":
            return (
              <div key={key} className="flex items-center gap-1.5 text-[12px] text-subtle">
                <Repeat2 className="h-3.5 w-3.5" />
                <span>
                  <span className="font-mono">{b.from}</span> declined; continued on <span className="font-mono">{b.to}</span> (server-side fallback)
                </span>
              </div>
            );
          case "notice":
            return <Notice key={key} tone={b.tone} text={b.text} />;
          default:
            return null;
        }
      })}
    </>
  );
}

function UserBubble({ m }: { m: UiMessage }) {
  const text = m.blocks
    .filter((b): b is Extract<UiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!text) return null;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border bg-surface-2 px-3.5 py-2 text-[14px] text-fg">{text}</div>
    </div>
  );
}

export type ChatSuggestion = { label: string; prompt: string };

export function AgentChat({
  agent,
  suggestions = [],
  page,
  compact,
  disabledReason,
  initialPrompt,
  autoSendInitial,
  className,
}: {
  agent: AgentHandle;
  suggestions?: ChatSuggestion[];
  page?: { deploymentId?: string | null; path?: string | null };
  compact?: boolean;
  disabledReason?: string | null;
  initialPrompt?: string | null;
  autoSendInitial?: boolean;
  className?: string;
}) {
  const [input, setInput] = useState(initialPrompt ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const sentInitial = useRef(false);

  useEffect(() => {
    if (initialPrompt) {
      setInput(initialPrompt);
      sentInitial.current = false;
    }
  }, [initialPrompt]);

  const actionsByToolUse = useMemo(() => {
    const m = new Map<string, UiAction>();
    for (const a of Object.values(agent.actions)) if (a.toolUseId) m.set(a.toolUseId, a);
    return m;
  }, [agent.actions]);

  const pendingCount = useMemo(() => Object.values(agent.actions).filter((a) => a.status === "PENDING_APPROVAL").length, [agent.actions]);

  // keep scrolled to the bottom while streaming unless the user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [agent.messages, agent.draft, agent.actions, agent.notices]);

  const submit = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || agent.busy || disabledReason) return;
    setInput("");
    stick.current = true;
    try {
      await agent.send(content, page);
    } catch {
      setInput(content);
    }
  };

  useEffect(() => {
    if (autoSendInitial && initialPrompt && !sentInitial.current && !agent.busy && !agent.loading && !disabledReason) {
      sentInitial.current = true;
      void submit(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSendInitial, initialPrompt, agent.loading, disabledReason]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const visible = agent.messages.filter((m) => m.role !== "tool");
  const empty = !visible.length && !agent.draft.length && !agent.busy;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "px-4 py-4" : "px-4 py-6 sm:px-6")}
        aria-live="polite"
      >
        {agent.loading ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Spinner />
          </div>
        ) : empty ? (
          <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center text-center">
            <AgentAvatar className="h-10 w-10" />
            <h3 className="mt-3 text-[15px] font-semibold text-fg">LevantDeploy Agent</h3>
            <p className="mt-1 max-w-sm text-[13px] text-muted">Ask about builds, logs, env vars, domains or deployments. Changes are only applied after you approve them.</p>
            {suggestions.length > 0 && (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button key={s.label} type="button" disabled={!!disabledReason} onClick={() => void submit(s.prompt)} className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50">
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className={cn("mx-auto space-y-5", compact ? "max-w-none" : "max-w-3xl")}>
            {visible.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} m={m} />
              ) : (
                <div key={m.id} className="flex gap-3">
                  <AgentAvatar />
                  <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                    <Blocks blocks={m.blocks} actionsByToolUse={actionsByToolUse} agent={agent} />
                  </div>
                </div>
              ),
            )}
            {(agent.draft.length > 0 || agent.busy) && (
              <div className="flex gap-3">
                <AgentAvatar />
                <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                  <Blocks blocks={[...agent.draft].sort((a, b) => a.index - b.index)} actionsByToolUse={actionsByToolUse} agent={agent} live />
                  {agent.busy && (
                    <div className="flex items-center gap-2 text-[12.5px] text-subtle">
                      <span className="flex gap-1">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-subtle" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-subtle [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-subtle [animation-delay:300ms]" />
                      </span>
                      Working…
                    </div>
                  )}
                </div>
              </div>
            )}
            {agent.notices.map((n) => (
              <div key={n.id} className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{n.message}</span>
                <button type="button" onClick={() => agent.dismissNotice(n.id)} aria-label="Dismiss" className="text-danger/70 hover:text-danger">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={cn("border-t border-border bg-bg", compact ? "p-3" : "px-4 py-3 sm:px-6")}>
        <div className={cn("mx-auto", compact ? "max-w-none" : "max-w-3xl")}>
          {disabledReason ? (
            <Notice tone="info" text={disabledReason} />
          ) : (
            <>
              {pendingCount > 0 && !agent.busy && <p className="mb-2 text-[12px] text-warning">{pendingCount === 1 ? "1 action is" : `${pendingCount} actions are`} waiting for your approval. Sending a new message rejects it.</p>}
              <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-1.5 focus-within:border-border-strong">
                <textarea
                  ref={taRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  placeholder="Ask the agent…"
                  title="Enter to send, Shift+Enter for a new line"
                  className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-[14px] leading-5 text-fg placeholder:text-subtle focus:outline-none"
                  aria-label="Message the agent"
                />
                {agent.busy ? (
                  <Button size="icon-sm" variant="secondary" onClick={agent.stop} aria-label="Stop">
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </Button>
                ) : (
                  <Button size="icon-sm" variant="primary" onClick={() => void submit()} disabled={!input.trim()} aria-label="Send">
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
