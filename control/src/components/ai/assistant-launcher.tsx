"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { History, Maximize2, Plus, Settings, Sparkles, X } from "lucide-react";
import { AI_OPEN_EVENT, type AiOpenDetail, type UiConversation } from "@/lib/ai/types";
import { Button, Dialog, Dropdown } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AgentChat, type ChatSuggestion } from "./agent-chat";
import { AiSettingsForm } from "./ai-settings";
import { ConversationList, useConversations } from "./conversation-list";
import { useAgent } from "./use-agent";
import { disabledReasonFor, useAiStatus } from "./use-ai-status";

const PROJECT_SUGGESTIONS: ChatSuggestion[] = [
  { label: "Why did my last deployment fail?", prompt: "Why did my last deployment fail? Diagnose it and propose a fix." },
  { label: "Summarise this project's setup", prompt: "Summarise this project's configuration: build, runtime, domains and environment variable keys." },
  { label: "Point my domain here", prompt: "How do I point my custom domain at this project? Explain the DNS records." },
  { label: "Any errors in runtime logs?", prompt: "Check the runtime logs of the current production deployment for errors." },
];
const TEAM_SUGGESTIONS: ChatSuggestion[] = [
  { label: "Which projects are failing?", prompt: "List my projects and tell me which ones have a failing latest deployment." },
  { label: "How do deployments work here?", prompt: "Explain how deployments, previews and rollbacks work on LevantDeploy." },
  { label: "Deploy from my laptop", prompt: "How do I deploy a local folder with the levant CLI?" },
];

/**
 * Global assistant: floating button (bottom-right) + slide-over panel, mounted once in the dashboard shell
 * (src/app/(dashboard)/[team]/layout.tsx). Context = the current project when on a project page, else the team.
 * Open it from anywhere: window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail: { prompt, autoSend } })).
 * Shortcut: ⌘J / Ctrl+J.
 */
export function AssistantLauncher() {
  const params = useParams<{ team?: string; project?: string; deploymentId?: string }>();
  const pathname = usePathname();
  const team = params.team ?? "";
  const project = params.project ?? null;
  const onAiPage = !!project && pathname?.endsWith(`/${project}/ai`);
  // builder-ui: the AI app Builder editor has its own chat → no floating button there (⌘J still opens the panel)
  const onBuilderEditor = !!team && !!pathname?.startsWith(`/${team}/build/`);
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ prompt: string; autoSend: boolean; nonce: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status = useAiStatus(open);
  const convs = useConversations(team, project, project ? "project" : "all");
  const agent = useAgent({ team, project, conversationId, onConversation: (c: UiConversation) => (setConversationId(c.id), void convs.refresh()) });

  // new context (navigated to another project) → start fresh
  useEffect(() => {
    setConversationId(null);
  }, [team, project]);

  const openWith = useCallback((detail?: AiOpenDetail) => {
    setOpen(true);
    if (detail?.prompt) {
      setConversationId(null);
      setPrefill({ prompt: detail.prompt, autoSend: !!detail.autoSend, nonce: Date.now() });
    }
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => openWith((e as CustomEvent<AiOpenDetail>).detail);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener(AI_OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(AI_OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [openWith]);

  if (!team) return null;
  const disabledReason = disabledReasonFor(status);

  return (
    <>
      {!open && !onAiPage && !onBuilderEditor && (
        <button
          type="button"
          onClick={() => openWith()}
          className="fixed bottom-5 right-5 z-40 flex h-11 items-center gap-2 rounded-full border border-border bg-fg pl-3.5 pr-4 text-[13px] font-medium text-bg shadow-pop transition-transform hover:scale-[1.03] active:scale-95"
          aria-label="Open the LevantDeploy Agent"
          title="LevantDeploy Agent (⌘J)"
          data-testid="ai-launcher"
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline">Ask AI</span>
        </button>
      )}
      <div className={cn("fixed inset-0 z-40 bg-black/30 transition-opacity sm:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")} onClick={() => setOpen(false)} />
      <aside
        className={cn(
          "fixed bottom-0 right-0 top-0 z-50 flex w-full flex-col border-l border-border bg-bg shadow-pop transition-transform duration-200 sm:w-[440px]",
          open ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
        aria-hidden={!open}
        aria-label="LevantDeploy Agent"
        data-testid="ai-panel"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <Sparkles className="ml-1 h-4 w-4 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-fg">{agent.conversation?.title && agent.conversation.title !== "New conversation" ? agent.conversation.title : "LevantDeploy Agent"}</p>
            <p className="truncate text-[11.5px] text-subtle">{project ? <>Project · <span className="font-mono">{project}</span></> : <>Team · <span className="font-mono">{team}</span></>}</p>
          </div>
          <Dropdown
            align="end"
            width={288}
            trigger={() => (
              <Button size="icon-sm" variant="ghost" aria-label="Conversation history" onClick={() => void convs.refresh()}>
                <History className="h-4 w-4" />
              </Button>
            )}
          >
            {(close) => (
              <div className="max-h-80 overflow-y-auto">
                <ConversationList
                  items={convs.items}
                  activeId={conversationId}
                  showProject={!project}
                  onSelect={(c) => {
                    setPrefill(null);
                    setConversationId(c.id);
                    close();
                  }}
                />
              </div>
            )}
          </Dropdown>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New conversation"
            onClick={() => {
              setPrefill(null);
              setConversationId(null);
              agent.reset();
            }}
          >
            <Plus className="h-4 w-4" />
          </Button>
          {project && (
            <Link href={`/${team}/${project}/ai${conversationId ? `?c=${conversationId}` : ""}`} onClick={() => setOpen(false)} aria-label="Open full page" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
              <Maximize2 className="h-3.5 w-3.5" />
            </Link>
          )}
          {status?.canConfigure && (
            <Button size="icon-sm" variant="ghost" aria-label="AI settings" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" />
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        {open && (
          <AgentChat
            key={`${team}/${project ?? ""}`}
            agent={agent}
            compact
            suggestions={project ? PROJECT_SUGGESTIONS : TEAM_SUGGESTIONS}
            page={{ deploymentId: params.deploymentId ?? null, path: pathname }}
            disabledReason={disabledReason}
            initialPrompt={prefill ? prefill.prompt : null}
            autoSendInitial={prefill?.autoSend}
          />
        )}
      </aside>
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings → AI" description="Platform-wide settings for the LevantDeploy Agent." size="lg">
        <AiSettingsForm />
      </Dialog>
    </>
  );
}
