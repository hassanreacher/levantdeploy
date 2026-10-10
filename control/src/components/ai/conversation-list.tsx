"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import type { UiConversation } from "@/lib/ai/types";
import { Skeleton } from "@/components/ui";
import { cn, timeAgo } from "@/lib/utils";

export function useConversations(team: string, project?: string | null, scope?: "project" | "team" | "all") {
  const [items, setItems] = useState<UiConversation[] | null>(null);
  const refresh = useCallback(async () => {
    const q = new URLSearchParams({ team });
    if (project) q.set("project", project);
    if (scope) q.set("scope", scope);
    try {
      setItems((await api<{ items: UiConversation[] }>(`/api/v1/ai/conversations?${q}`)).items);
    } catch {
      setItems([]);
    }
  }, [team, project, scope]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const remove = useCallback(async (id: string) => {
    await api(`/api/v1/ai/conversations/${id}`, { method: "DELETE" });
    setItems((l) => l?.filter((c) => c.id !== id) ?? null);
  }, []);
  return { items, refresh, remove };
}

export function ConversationList({
  items,
  activeId,
  onSelect,
  onDelete,
  showProject,
}: {
  items: UiConversation[] | null;
  activeId: string | null;
  onSelect: (c: UiConversation) => void;
  onDelete?: (c: UiConversation) => void;
  showProject?: boolean;
}) {
  if (!items)
    return (
      <div className="space-y-2 p-2">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    );
  if (!items.length) return <p className="px-3 py-6 text-center text-[12.5px] text-subtle">No conversations yet.</p>;
  return (
    <ul className="space-y-0.5 p-1.5">
      {items.map((c) => (
        <li key={c.id} className="group relative">
          <button
            type="button"
            onClick={() => onSelect(c)}
            className={cn("flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors", c.id === activeId ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg")}
          >
            <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{c.title}</span>
              <span className="block truncate text-[11.5px] text-subtle">
                {showProject ? `${c.projectSlug ?? "team"} · ` : ""}
                {timeAgo(c.updatedAt)}
              </span>
            </span>
          </button>
          {onDelete && (
            <button type="button" onClick={() => onDelete(c)} aria-label="Delete conversation" className="absolute right-1.5 top-2 hidden rounded p-1 text-subtle hover:bg-surface hover:text-danger group-hover:block">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
