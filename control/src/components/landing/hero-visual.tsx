"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { HeroFallback } from "./hero-fallback";
import type { SceneTheme } from "./hero-scene";

// three.js + R3F live in their own chunk, fetched only on the client, after the page is interactive.
const HeroScene = dynamic(() => import("./hero-scene"), { ssr: false, loading: () => null });

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function currentTheme(): SceneTheme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/**
 * Hero motion graphic: transparent WebGL canvas when possible, static SVG otherwise (SSR, loading, reduced motion,
 * no WebGL, ?static=1). The canvas is paused while scrolled out of view.
 */
export function HeroVisual({ className }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const [theme, setTheme] = useState<SceneTheme>("dark");

  useEffect(() => {
    setTheme(currentTheme());
    const mo = new MutationObserver(() => setTheme(currentTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forceStatic = new URLSearchParams(window.location.search).has("static");
    let idle: number | undefined;
    const evaluate = () => {
      const ok = !mq.matches && !forceStatic && webglAvailable();
      if (!ok) {
        setEnabled(false);
        setReady(false);
        return;
      }
      // load after first paint / when the main thread is idle → keeps the hero text LCP fast
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) idle = ric(() => setEnabled(true), { timeout: 1200 });
      else idle = window.setTimeout(() => setEnabled(true), 200);
    };
    evaluate();
    mq.addEventListener("change", evaluate);

    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "100px" });
    if (box.current) io.observe(box.current);
    return () => {
      mo.disconnect();
      io.disconnect();
      mq.removeEventListener("change", evaluate);
      if (idle !== undefined) window.clearTimeout(idle);
    };
  }, []);

  return (
    <div ref={box} className={cn("relative", className)} aria-hidden data-hero-visual={enabled ? (ready ? "webgl" : "loading") : "static"}>
      <div className={cn("absolute inset-0 transition-opacity duration-700", ready ? "opacity-0" : "opacity-100")}>
        <HeroFallback />
      </div>
      {enabled && (
        <div className={cn("absolute inset-0 transition-opacity duration-700", ready ? "opacity-100" : "opacity-0")} data-hero-canvas>
          <HeroScene theme={theme} paused={!visible} onReady={() => setReady(true)} />
        </div>
      )}
    </div>
  );
}
