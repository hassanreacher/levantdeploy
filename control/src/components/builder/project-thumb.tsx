"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import type { BuilderProject } from "@/lib/builder-ui/types";

/**
 * Live thumbnail: the stored screenshot when builder-core provides one, else a scaled-down, non-interactive iframe of
 * the running preview (loaded lazily when visible), else a generated placeholder.
 */
export function ProjectThumb({ p, className }: { p: BuilderProject; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [w, setW] = useState(320);
  const live = p.previewStatus === "RUNNING" && !!p.previewUrl && !p.previewUrl.startsWith("mock:");
  // the preview is behind the session gate: frame it through a one-time SSO URL
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!live || !visible || p.thumbnailUrl || src) return;
    builderApi()
      .previewUrl(p.id, "/")
      .then(setSrc, () => {});
  }, [live, visible, p.id, p.thumbnailUrl, src]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  const scale = w / 1280;
  return (
    <div ref={box} className={cn("relative aspect-[16/10] overflow-hidden bg-bg-subtle", className)} aria-hidden>
      {p.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
      ) : live && src ? (
        <iframe
          src={src}
          title=""
          tabIndex={-1}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white"
          style={{ width: 1280, height: 800, transform: `scale(${scale})` }}
        />
      ) : (
        <Placeholder name={p.name} generating={p.status === "GENERATING"} />
      )}
    </div>
  );
}

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Placeholder({ name, generating }: { name: string; generating?: boolean }) {
  const h = hue(name);
  return (
    <div className="absolute inset-0 flex flex-col p-4" style={{ background: `radial-gradient(120% 90% at 0% 0%, hsl(${h} 70% 55% / .22), transparent 60%), radial-gradient(100% 80% at 100% 100%, hsl(${(h + 60) % 360} 70% 55% / .18), transparent 60%)` }}>
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 rounded-full bg-fg/15" />
        ))}
      </div>
      <div className="mt-auto space-y-1.5">
        <div className={cn("h-2.5 w-2/3 rounded bg-fg/15", generating && "animate-pulse2")} />
        <div className={cn("h-2 w-1/2 rounded bg-fg/10", generating && "animate-pulse2")} />
      </div>
      <span className="absolute right-4 top-3 text-[28px] font-semibold tracking-tight text-fg/20">{name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}
