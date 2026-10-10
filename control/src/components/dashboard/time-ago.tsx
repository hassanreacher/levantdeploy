"use client";

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/utils";

/** Relative time that keeps itself fresh; full timestamp in the tooltip. */
export function TimeAgo({ date, className }: { date: string | Date | null | undefined; className?: string }) {
  const [mounted, tick] = useState(0);
  useEffect(() => {
    tick(1);
    const i = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(i);
  }, []);
  if (!date) return <span className={className}>—</span>;
  const d = new Date(date);
  return (
    // the locale-formatted tooltip is only set after mount (server and browser locales/time zones differ)
    <time dateTime={d.toISOString()} title={mounted ? d.toLocaleString() : undefined} className={className} suppressHydrationWarning>
      {timeAgo(d)}
    </time>
  );
}

/** Live elapsed time ("1m 12s") while a deployment is running. */
export function Elapsed({ from, to, className }: { from: string | Date; to?: string | Date | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (to) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [to]);
  const ms = Math.max(0, (to ? new Date(to).getTime() : now) - new Date(from).getTime());
  const s = Math.floor(ms / 1000);
  return (
    <span className={className} suppressHydrationWarning>
      {s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`}
    </span>
  );
}
