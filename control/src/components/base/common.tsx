"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Spinner } from "@/components/ui";
import { NavTabs } from "@/components/ui/tabs";
import { BASE_PAGES, BASE_STATUS_STYLE, type BaseEventDTO, type BaseStatus } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";

export function BaseStatusBadge({ status, className }: { status: string; className?: string }) {
  const s = BASE_STATUS_STYLE[status as BaseStatus] ?? { label: status, tone: "neutral" as const };
  return (
    <Badge tone={s.tone} className={className} icon={s.busy ? <Spinner className="h-3 w-3" /> : <span className={cn("h-1.5 w-1.5 rounded-full", dotClass(status))} />}>
      {s.label}
    </Badge>
  );
}

export function dotClass(status: string) {
  const t = BASE_STATUS_STYLE[status as BaseStatus]?.tone ?? "neutral";
  return t === "success" ? "bg-success" : t === "warning" ? "bg-warning" : t === "danger" ? "bg-danger" : "bg-subtle";
}

/** Second-level navigation of a Base project (Home, Database, Auth, Functions, Logs, Usage, Settings). */
export function BaseSubNav({ basePath, sticky = false }: { basePath: string; sticky?: boolean }) {
  const tabs = BASE_PAGES.map((p) => ({ href: p.seg ? `${basePath}/${p.seg}` : basePath, label: p.label, exact: p.seg === "" }));
  return (
    <div className={cn("border-b border-border bg-bg", sticky && "sticky top-14 z-20 bg-bg/80 backdrop-blur-md")}>
      <div className="px-2 sm:px-4">
        <NavTabs tabs={tabs} />
      </div>
    </div>
  );
}

/**
 * Live status + events of a Base project (SSE /api/v1/base/projects/:ref/events). Hidden tabs close the stream.
 * `onStatus` fires on every status change after the first one.
 */
export function useBaseLive(ref: string, opts: { onStatus?: (status: string) => void; enabled?: boolean } = {}) {
  const [events, setEvents] = useState<BaseEventDTO[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const onStatus = useRef(opts.onStatus);
  onStatus.current = opts.onStatus;
  const enabled = opts.enabled !== false;
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let first: string | null = null;
    const open = () => {
      if (es) return;
      setEvents([]);
      es = new EventSource(`/api/v1/base/projects/${ref}/events`);
      es.onopen = () => setConnected(true);
      es.addEventListener("event", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as BaseEventDTO;
          setEvents((cur) => (cur.some((x) => x.id === ev.id) ? cur : [...cur, ev].slice(-200)));
        } catch {}
      });
      es.addEventListener("status", (e) => {
        try {
          const s = JSON.parse((e as MessageEvent).data) as { status: string; statusMessage: string | null };
          setStatus(s.status);
          setMessage(s.statusMessage);
          if (first === null) first = s.status;
          else onStatus.current?.(s.status);
        } catch {}
      });
      es.onerror = () => setConnected(false);
    };
    const shut = () => {
      es?.close();
      es = null;
      setConnected(false);
    };
    const vis = () => (document.hidden ? shut() : open());
    open();
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      shut();
    };
  }, [ref, enabled]);
  return { events, status, message, connected };
}

/** Server pages: refresh when the project's status changes (pause/resume/restart finished …). */
export function BaseLiveRefresh({ refId }: { refId: string }) {
  const router = useRouter();
  useBaseLive(refId, { onStatus: () => router.refresh() });
  return null;
}
