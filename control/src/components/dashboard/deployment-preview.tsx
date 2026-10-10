"use client";

import { useState } from "react";
import { ExternalLink, Lock } from "lucide-react";
import { STATUS_STYLE, type DeploymentStatusName } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { FrameworkIcon } from "./framework-icon";

/**
 * Deployment preview "thumbnail": a screenshot when one exists (`screenshotUrl`, e.g. captured by the runtime area
 * into meta.screenshot), otherwise a browser-frame card with the site's favicon (falls back to the framework mark).
 */
export function DeploymentPreview({
  url,
  host,
  status,
  framework,
  screenshotUrl,
  protectedPreview,
  className,
}: {
  url: string;
  host: string;
  status: DeploymentStatusName;
  framework: string | null;
  screenshotUrl?: string | null;
  protectedPreview?: boolean;
  className?: string;
}) {
  const [favLoaded, setFavLoaded] = useState(false);
  const [shotOk, setShotOk] = useState(true);
  const live = status === "READY";
  const s = STATUS_STYLE[status];
  return (
    <a
      href={live ? url : undefined}
      target="_blank"
      rel="noreferrer"
      className={cn("group relative block overflow-hidden rounded-md border border-border bg-bg-subtle", live && "hover:border-border-strong", className)}
      aria-label={`Preview of ${host}`}
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-surface px-3">
        <span className="h-2 w-2 rounded-full bg-border-strong" />
        <span className="h-2 w-2 rounded-full bg-border-strong" />
        <span className="h-2 w-2 rounded-full bg-border-strong" />
        <span className="ml-2 flex min-w-0 flex-1 items-center gap-1 truncate rounded bg-bg-subtle px-2 py-0.5 font-mono text-[10px] text-subtle">
          {protectedPreview && <Lock className="h-2.5 w-2.5 shrink-0" />}
          <span className="truncate">{host}</span>
        </span>
      </div>
      <div className="relative aspect-[16/10] w-full">
        {screenshotUrl && shotOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={screenshotUrl} alt="" className="h-full w-full object-cover object-top" onError={() => setShotOk(false)} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_1px_1px,rgb(var(--border))_1px,transparent_0)] [background-size:16px_16px]">
            <span className="relative inline-flex h-11 w-11 items-center justify-center">
              {!favLoaded && <FrameworkIcon framework={framework} size={44} />}
              {live && url.startsWith("https://") && (
                // favicon of the live site (https only: the dashboard CSP blocks mixed-content images)
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${url.replace(/\/$/, "")}/favicon.ico`}
                  alt=""
                  width={40}
                  height={40}
                  className={cn("h-10 w-10 rounded-md", favLoaded ? "" : "absolute opacity-0")}
                  onLoad={(e) => (e.currentTarget.naturalWidth > 0 ? setFavLoaded(true) : undefined)}
                />
              )}
            </span>
            <span className="max-w-[80%] truncate font-mono text-[12px] text-muted">{host}</span>
          </div>
        )}
        {!live && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70 backdrop-blur-[1px]">
            <span className={cn("rounded-full border border-border bg-surface px-3 py-1 text-[12px] font-medium", s.text)}>{s.label}</span>
          </div>
        )}
        {live && (
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface/90 px-2 py-1 text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
            Visit <ExternalLink className="h-3 w-3" />
          </span>
        )}
      </div>
    </a>
  );
}
