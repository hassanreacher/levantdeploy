"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { LogViewer } from "@/components/ui";
import { BASE_SERVICES, LOG_SERVICES } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";

/** Per-service live log tail (same viewer as Deploy runtime logs). */
export function BaseLogsClient({ refId, initialService, paused }: { refId: string; initialService?: string; paused?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [service, setService] = useState<string>(initialService && (LOG_SERVICES as readonly string[]).includes(initialService) ? initialService : "api-gw");
  const services = BASE_SERVICES.filter((s) => s.logs);
  const pick = (s: string) => {
    setService(s);
    router.replace(`${pathname}?service=${s}`, { scroll: false });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
      <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Services">
        {services.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => pick(s.id)}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-left text-[13px] transition-colors",
              service === s.id ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
            )}
          >
            {s.label}
            <span className="hidden text-[12px] font-normal text-subtle lg:block">{s.desc}</span>
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {paused && <div className="mb-3 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted">The project is paused — showing the last lines written before it stopped.</div>}
        <LogViewer key={service} src={`/api/v1/base/projects/${refId}/logs?service=${service}`} height="calc(100vh - 300px)" emptyText={`Waiting for ${service} logs…`} />
      </div>
    </div>
  );
}
