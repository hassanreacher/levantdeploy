"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * Live deployment status updates. One EventSource per tab on /api/v1/teams/:team/events (SSE),
 * shared through context:
 *   <TeamEventsProvider team={team.slug}>…</TeamEventsProvider>          (team layout)
 *   useDeploymentEvents((ev) => …)                                      (any client component)
 *   <LiveRefresh projectId={p.id} />                                     (server pages: router.refresh() on change)
 */
export type LiveStatusEvent = { deploymentId: string; projectId: string; status: string; from: string; at: number };
type Listener = (ev: LiveStatusEvent) => void;
type Ctx = { subscribe: (fn: Listener) => () => void; connected: boolean };

const EventsCtx = createContext<Ctx | null>(null);

export function TeamEventsProvider({ team, children }: { team: string; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  const [ctx] = useState<Omit<Ctx, "connected">>(() => ({
    subscribe: (fn: Listener) => {
      listeners.current.add(fn);
      return () => void listeners.current.delete(fn);
    },
  }));
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const open = () => {
      if (es || closed) return;
      es = new EventSource(`/api/v1/teams/${encodeURIComponent(team)}/events`);
      es.onopen = () => setConnected(true);
      es.addEventListener("status", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as LiveStatusEvent;
          for (const l of listeners.current) l(ev);
        } catch {}
      });
      es.onerror = () => {
        setConnected(false);
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          if (!closed) retry = setTimeout(open, 5000);
        }
      };
    };
    const shut = () => {
      if (retry) clearTimeout(retry);
      es?.close();
      es = null;
      setConnected(false);
    };
    // Hidden tabs give their connection back: browsers allow only ~6 HTTP/1.1 connections per host,
    // and every dashboard tab would otherwise hold one open forever. Missed changes → refresh on return.
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        shut();
      } else {
        open();
        if (hiddenAt) for (const l of listeners.current) l({ deploymentId: "*", projectId: "*", status: "RESYNC", from: "RESYNC", at: Date.now() });
      }
    };
    if (document.visibilityState !== "hidden") open();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVis);
      shut();
    };
  }, [team]);
  return <EventsCtx.Provider value={{ ...ctx, connected }}>{children}</EventsCtx.Provider>;
}

export function useLiveConnected() {
  return useContext(EventsCtx)?.connected ?? false;
}

/**
 * Subscribe to status events (no-op outside a TeamEventsProvider). After a hidden tab becomes visible again a
 * synthetic `{ deploymentId: "*", projectId: "*", status: "RESYNC" }` event is delivered: refetch your data.
 */
export function useDeploymentEvents(fn: Listener) {
  const ctx = useContext(EventsCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ctx?.subscribe((ev) => ref.current(ev)), [ctx]);
}

/** Re-renders the current server page (debounced) when a matching deployment changes status. */
export function LiveRefresh({ projectId, deploymentId, delay = 400 }: { projectId?: string; deploymentId?: string; delay?: number }) {
  const router = useRouter();
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useDeploymentEvents((ev) => {
    if (projectId && ev.projectId !== projectId && ev.projectId !== "*") return;
    if (deploymentId && ev.deploymentId !== deploymentId && ev.deploymentId !== "*") return;
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => router.refresh(), delay);
  });
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  return null;
}

/** Small "Live" indicator. */
export function LiveBadge({ className }: { className?: string }) {
  const on = useLiveConnected();
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${on ? "text-success" : "text-subtle"} ${className ?? ""}`} title={on ? "Live updates connected" : "Live updates disconnected"}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-success" : "bg-subtle"}`} />
      {on ? "Live" : "Offline"}
    </span>
  );
}
