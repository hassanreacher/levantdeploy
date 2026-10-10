"use client";

import { useEffect } from "react";

/**
 * Scroll reveals without a JS animation library: elements with [data-reveal] fade/slide in once they enter the
 * viewport (CSS in landing.css). Content is visible without JS; elements already on screen are never hidden.
 */
export function RevealObserver() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const vh = window.innerHeight;
    for (const el of els) if (el.getBoundingClientRect().top < vh * 0.95) el.dataset.in = "";
    document.documentElement.classList.add("lf-reveal-ready");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.in = "";
            io.unobserve(e.target);
          }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    els.filter((el) => !("in" in el.dataset)).forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      document.documentElement.classList.remove("lf-reveal-ready");
    };
  }, []);
  return null;
}
