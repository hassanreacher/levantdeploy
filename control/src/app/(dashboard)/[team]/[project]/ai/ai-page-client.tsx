"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Plus, Settings, Sparkles } from "lucide-react";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Badge, Button, Dialog } from "@/components/ui";
import { AgentChat, type ChatSuggestion } from "@/components/ai/agent-chat";
import { AiSettingsForm } from "@/components/ai/ai-settings";
import { AskAiButton } from "@/components/ai/ask-ai";
import { ConversationList, useConversations } from "@/components/ai/conversation-list";
import { useAgent } from "@/components/ai/use-agent";
import { disabledReasonFor, useAiStatus } from "@/components/ai/use-ai-status";
import { timeAgo } from "@/lib/utils";

type Failure = { id: string; number: number; errorStep: string | null; errorMessage: string | null; branch: string | null; createdAt: string; diagnosis: { summary: string } | null };

const SUGGESTIONS: ChatSuggestion[] = [
  { label: "Why did my last deployment fail?", prompt: "Why did my last deployment fail? Diagnose it and propose a fix." },
  { label: "Review my build settings", prompt: "Review this project's build and runtime settings and tell me if anything looks wrong." },
  { label: "Which env vars are set?", prompt: "Which environment variable keys does this project have, per target?" },
  { label: "Set up a custom domain", prompt: "How do I point my custom domain at this project? Explain the DNS records." },
  { label: "Generate a Dockerfile", prompt: "Generate a Dockerfile for this project and explain it." },
];

export function AiPageClient({
  team,
  project,
  projectName,
  initialConversationId,
  initialPrompt,
  autoSend,
  failures,
}: {
  team: string;
  project: string;
  projectName: string;
  initialConversationId: string | null;
  initialPrompt: string | null;
  autoSend: boolean;
  failures: Failure[];
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [prefill, setPrefill] = useState<{ prompt: string; autoSend: boolean } | null>(initialPrompt ? { prompt: initialPrompt, autoSend } : null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status = useAiStatus();
  const convs = useConversations(team, project, "project");
  const select = (id: string | null) => {
    setConversationId(id);
    router.replace(id ? `?c=${id}` : "?", { scroll: false });
  };
  const agent = useAgent({
    team,
    project,
    conversationId,
    onConversation: (c) => {
      select(c.id);
      void convs.refresh();
    },
  });
  const startNew = (p?: { prompt: string; autoSend: boolean }) => {
    agent.reset();
    select(null);
    setPrefill(p ?? null);
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            AI Agent <Badge tone="accent">Beta</Badge>
          </span>
        }
        description={<>Diagnose builds, configure and operate <span className="text-fg">{projectName}</span> in plain language. Every change waits for your approval.</>}
        actions={
          <>
            {status?.canConfigure && (
              <Button variant="secondary" leftIcon={<Settings className="h-4 w-4" />} onClick={() => setSettingsOpen(true)}>
                Settings
              </Button>
            )}
            <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => startNew()}>
              New chat
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="order-2 min-w-0 space-y-6 lg:order-1">
            <section>
              <h2 className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wide text-subtle">Conversations</h2>
              <div className="rounded-xl border border-border bg-surface">
                <ConversationList
                  items={convs.items}
                  activeId={conversationId}
                  onSelect={(c) => {
                    setPrefill(null);
                    select(c.id);
                  }}
                  onDelete={async (c) => {
                    await convs.remove(c.id);
                    if (c.id === conversationId) startNew();
                  }}
                />
              </div>
            </section>
            {failures.length > 0 && (
              <section>
                <h2 className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wide text-subtle">Recent failures</h2>
                <div className="space-y-2">
                  {failures.map((f) => (
                    <div key={f.id} className="rounded-xl border border-danger/25 bg-danger/5 p-3">
                      <div className="flex items-center gap-2 text-[13px]">
                        <AlertCircle className="h-3.5 w-3.5 text-danger" />
                        <span className="font-medium text-fg">#{f.number}</span>
                        <span className="truncate text-muted">{f.branch ?? ""}</span>
                        <span className="ml-auto shrink-0 text-[11.5px] text-subtle" suppressHydrationWarning>{timeAgo(f.createdAt)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{f.diagnosis?.summary.split("\n")[0]?.replace(/[*`]/g, "") ?? f.errorMessage ?? "Failed"}</p>
                      <AskAiButton className="mt-2 w-full" deployment={f} onAsk={(prompt) => startNew({ prompt, autoSend: true })} disabled={!!disabledReasonFor(status)} />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
          <div className="order-1 flex h-[calc(100dvh-300px)] min-h-[520px] flex-col overflow-hidden rounded-xl border border-border bg-bg lg:order-2" data-testid="ai-chat">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              <span className="truncate font-medium text-fg">{agent.conversation?.title ?? "New conversation"}</span>
              {status && <span className="ml-auto hidden font-mono text-[11.5px] text-subtle sm:inline">{status.model} · effort {status.effort}</span>}
            </div>
            <AgentChat
              agent={agent}
              suggestions={SUGGESTIONS}
              page={{ path: `/${team}/${project}/ai` }}
              disabledReason={disabledReasonFor(status)}
              initialPrompt={prefill?.prompt ?? null}
              autoSendInitial={prefill?.autoSend}
            />
          </div>
        </div>
      </PageBody>
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings → AI" description="Platform-wide settings for the LevantDeploy Agent." size="lg">
        <AiSettingsForm />
      </Dialog>
    </>
  );
}
