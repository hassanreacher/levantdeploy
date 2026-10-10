"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCircle2, XCircle, CheckCheck } from "lucide-react";
import { Dropdown } from "@/components/ui/dropdown";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { useDeploymentEvents } from "./live";
import { TimeAgo } from "./time-ago";

type Item = { id: string; kind: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string };

/** In-app notification bell (unread badge + latest 15). Refreshes on mount, every 60 s and after READY/ERROR events. */
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Item[]; unread: number }>("/api/v1/me/notifications?limit=15");
      setItems(r.items);
      setUnread(r.unread);
    } catch {}
  }, []);
  useEffect(() => {
    void load();
    const i = setInterval(load, 60_000);
    return () => clearInterval(i);
  }, [load]);
  useDeploymentEvents((ev) => {
    if (ev.status === "RESYNC") void load();
    else if (ev.status === "READY" || ev.status === "ERROR") setTimeout(load, 2500); // the notify worker runs right after
  });
  const markAll = async () => {
    setUnread(0);
    setItems((l) => l.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    await api("/api/v1/me/notifications/read", { method: "POST", body: {} }).catch(() => {});
  };
  const markOne = (id: string) => {
    const it = items.find((x) => x.id === id);
    if (!it || it.readAt) return;
    setUnread((u) => Math.max(0, u - 1));
    setItems((l) => l.map((x) => (x.id === id ? { ...x, readAt: new Date().toISOString() } : x)));
    void api("/api/v1/me/notifications/read", { method: "POST", body: { ids: [id] } }).catch(() => {});
  };
  return (
    <Dropdown
      align="end"
      width={360}
      className="p-0 max-sm:fixed max-sm:inset-x-3 max-sm:top-14 max-sm:!w-auto"
      trigger={() => (
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:border-border-strong hover:text-fg"
          aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
          data-testid="notification-bell"
          onClick={() => void load()}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-[13px] font-semibold text-fg">Notifications</p>
            <button onClick={markAll} disabled={!unread} className="inline-flex items-center gap-1 text-[12px] text-muted transition-colors hover:text-fg disabled:opacity-40">
              <CheckCheck className="h-3.5 w-3.5" /> Mark all as read
            </button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-subtle">You're all caught up.</p>
            ) : (
              items.map((n) => {
                const ok = n.kind.endsWith("ready");
                const inner = (
                  <div className={cn("flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2", !n.readAt && "bg-accent/[0.04]")}>
                    {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium leading-snug text-fg">{n.title}</p>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{n.body}</p>}
                      <TimeAgo date={n.createdAt} className="mt-1 block text-[11px] text-subtle" />
                    </div>
                    {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="unread" />}
                  </div>
                );
                return n.href ? (
                  <Link key={n.id} href={n.href} onClick={() => (markOne(n.id), close())} className="block border-b border-border last:border-0">
                    {inner}
                  </Link>
                ) : (
                  <div key={n.id} className="border-b border-border last:border-0" onClick={() => markOne(n.id)}>
                    {inner}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </Dropdown>
  );
}
