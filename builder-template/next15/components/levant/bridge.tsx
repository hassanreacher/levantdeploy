"use client";

/**
 * LevantDeploy visual-editor bridge (dev-only; rendered by app/layout.tsx when NEXT_PUBLIC_LEVANT_EDITOR=1).
 * Do not import it anywhere else — production builds never include it (the flag is inlined as "0").
 *
 * Every JSX element carries data-lv-src="relpath:line:col" (added by levant/lv-src-loader.cjs in the preview's dev
 * server). The bridge talks to the editor (window.parent) with postMessage. Every message carries `__lv: 1` and
 * `source: "levant-bridge"`. `ElementInfo` = { src, tag, text, textEditable, className, classes, styles, attrs, rect,
 * sectionSrc, parentSrc, siblings, file }, rect = { x, y, w, h, width, height } (viewport px).
 *
 * bridge → editor
 *   ready     { version, route, path }
 *   hover     { el: ElementInfo | null, src, tag, rect }
 *   select    { el: ElementInfo, src, tag, text, classes, rect }            (click in edit mode)
 *   deselect  {}
 *   text      { src, text, previous }                                      (inline edit committed: Enter / blur)
 *   move      { src, target, position: "before"|"after", beforeSrc? , afterSrc? }   (drag handle dropped)
 *   error     { message, stack?, source: "runtime"|"unhandledrejection"|"overlay"|"console", route }
 *   navigate  { path }
 *   pong      { version }
 * editor → bridge (`__lv: 1` or `source: "levant-editor"`, only from window.parent)
 *   mode { enabled: boolean } | mode { mode: "edit"|"interact" }   (edit = hover/select/drag; otherwise normal app)
 *   select { src | null }   editText { src }   applyClass { src, add?, remove? }   applyStyle { src, style }
 *   applyAttr { src, name, value }   navigate { path }   reload {}   ping {}
 *   (apply* are optimistic live previews; the editor persists them through POST /api/v1/builder/projects/:id/visual-edit)
 * Errors are also POSTed to /__levant/errors (same origin, behind the preview gate) so agents can read them even
 * when no editor is open.
 */

import { useEffect } from "react";

const VERSION = 2;
const OUTLINE_Z = 2147483646;
const ACCENT = "#6366f1";
const SECTION_TAGS = new Set(["section", "header", "footer", "nav", "aside", "article"]);

type Mode = "edit" | "interact";
type Msg = Record<string, unknown>;

function post(msg: Msg) {
  try {
    window.parent?.postMessage({ __lv: 1, source: "levant-bridge", ...msg }, "*");
  } catch {
    /* ignore */
  }
}

const sentErrors = new Map<string, number>();
function reportError(source: string, message: string, stack?: string) {
  const key = `${source}:${message}`.slice(0, 500);
  const now = Date.now();
  if (now - (sentErrors.get(key) ?? 0) < 5000) return;
  sentErrors.set(key, now);
  const payload = { source, message: message.slice(0, 4000), stack: stack?.slice(0, 8000), route: location.pathname, at: new Date().toISOString() };
  post({ type: "error", ...payload });
  try {
    void fetch("/__levant/errors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), keepalive: true }).catch(
      () => {},
    );
  } catch {
    /* ignore */
  }
}

const isUi = (el: Element | null) => !!el?.closest?.("[data-lv-ui]");

function srcOf(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    if (cur instanceof HTMLElement && cur.dataset.lvSrc && !isUi(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

const bySrc = (src: string) => document.querySelector(`[data-lv-src="${CSS.escape(src)}"]`) as HTMLElement | null;

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, width: r.width, height: r.height };
}

/** text-only element: has text and no element children (inline editing maps to a JSX text child) */
function isTextOnly(el: HTMLElement) {
  if (!el.textContent?.trim()) return false;
  for (const n of Array.from(el.childNodes)) if (n.nodeType !== Node.TEXT_NODE && n.nodeType !== Node.COMMENT_NODE) return false;
  return true;
}

function siblingsOf(el: HTMLElement): HTMLElement[] {
  const p = el.parentElement;
  if (!p) return [];
  return Array.from(p.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.lvSrc && !c.hasAttribute("data-lv-ui"));
}

function sectionOf(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el;
  let last: HTMLElement | null = null;
  while (cur && cur !== document.body) {
    if (cur.dataset.lvSrc) {
      if (SECTION_TAGS.has(cur.tagName.toLowerCase())) return cur;
      if (cur.parentElement?.tagName.toLowerCase() === "main" || cur.parentElement === document.body) return cur;
      last = cur;
    }
    cur = cur.parentElement;
  }
  return last;
}

function info(el: HTMLElement) {
  const attrs: Record<string, string> = {};
  for (const a of ["href", "src", "alt", "target", "placeholder", "title"]) {
    const v = el.getAttribute(a);
    if (v != null) attrs[a] = v;
  }
  const cs = getComputedStyle(el);
  const parent = el.parentElement ? srcOf(el.parentElement) : null;
  const src = el.dataset.lvSrc!;
  const className = el.getAttribute("class") ?? "";
  return {
    src,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText ?? el.textContent ?? "").slice(0, 2000),
    textEditable: isTextOnly(el),
    className,
    classes: className,
    styles: {
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      margin: cs.margin,
      borderRadius: cs.borderRadius,
      textAlign: cs.textAlign,
      width: cs.width,
    },
    attrs,
    rect: rectOf(el),
    sectionSrc: sectionOf(el)?.dataset.lvSrc ?? null,
    parentSrc: parent?.dataset.lvSrc ?? null,
    siblings: siblingsOf(el).length,
    file: src.replace(/:\d+:\d+$/, ""),
  };
}

function makeBox(dashed: boolean) {
  const d = document.createElement("div");
  d.setAttribute("data-lv-ui", "");
  Object.assign(d.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: String(OUTLINE_Z),
    border: `${dashed ? 1 : 2}px ${dashed ? "dashed" : "solid"} ${ACCENT}`,
    borderRadius: "2px",
    display: "none",
    boxSizing: "border-box",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(d);
  return d;
}

function place(box: HTMLElement, el: Element | null) {
  if (!el) {
    box.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

export default function LevantBridge() {
  useEffect(() => {
    // framed by the editor → edit mode until told otherwise; opened directly (share link, new tab) → normal app
    let mode: Mode = window.top !== window ? "edit" : "interact";
    let hovered: HTMLElement | null = null;
    let selected: HTMLElement | null = null;
    let selectedSrc: string | null = null;
    let editing: { el: HTMLElement; previous: string } | null = null;
    let dragging: { el: HTMLElement; siblings: HTMLElement[]; target: { el: HTMLElement; before: boolean } | null } | null = null;

    const hoverBox = makeBox(true);
    const selectBox = makeBox(false);
    const label = document.createElement("div");
    label.setAttribute("data-lv-ui", "");
    Object.assign(label.style, {
      position: "fixed",
      zIndex: String(OUTLINE_Z + 1),
      background: ACCENT,
      color: "#fff",
      font: "500 11px/16px ui-sans-serif,system-ui,sans-serif",
      padding: "0 6px",
      borderRadius: "3px 3px 0 0",
      pointerEvents: "none",
      display: "none",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(label);

    const handle = document.createElement("div");
    handle.setAttribute("data-lv-ui", "");
    handle.title = "Drag to reorder";
    handle.textContent = "⠿";
    Object.assign(handle.style, {
      position: "fixed",
      zIndex: String(OUTLINE_Z + 1),
      width: "18px",
      height: "18px",
      background: ACCENT,
      color: "#fff",
      font: "14px/18px ui-sans-serif,system-ui,sans-serif",
      textAlign: "center",
      borderRadius: "4px",
      cursor: "grab",
      display: "none",
      touchAction: "none",
      userSelect: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(handle);

    const dropLine = document.createElement("div");
    dropLine.setAttribute("data-lv-ui", "");
    Object.assign(dropLine.style, {
      position: "fixed",
      zIndex: String(OUTLINE_Z),
      background: ACCENT,
      display: "none",
      pointerEvents: "none",
      borderRadius: "2px",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(dropLine);

    const refresh = () => {
      if (selected && !selected.isConnected) selected = selectedSrc ? bySrc(selectedSrc) : null; // replaced by HMR
      if (hovered && !hovered.isConnected) hovered = null;
      place(hoverBox, mode === "edit" && hovered && hovered !== selected ? hovered : null);
      place(selectBox, mode === "edit" ? selected : null);
      if (mode === "edit" && selected) {
        const r = selected.getBoundingClientRect();
        label.textContent = selected.tagName.toLowerCase();
        Object.assign(label.style, { display: "block", left: `${r.left}px`, top: `${Math.max(0, r.top - 16)}px` });
        const movable = !editing && siblingsOf(selected).length > 1;
        Object.assign(handle.style, { display: movable ? "block" : "none", left: `${Math.max(0, r.left - 22)}px`, top: `${Math.max(0, r.top)}px` });
      } else {
        label.style.display = "none";
        handle.style.display = "none";
      }
    };

    const select = (el: HTMLElement | null, notify = true) => {
      selected = el;
      selectedSrc = el?.dataset.lvSrc ?? null;
      refresh();
      if (!notify) return;
      if (el) {
        const i = info(el);
        post({ type: "select", el: i, src: i.src, tag: i.tag, text: i.text, classes: i.className, rect: i.rect });
      } else post({ type: "deselect" });
    };

    // ── inline text editing ──
    const finishEdit = (commit: boolean) => {
      if (!editing) return;
      const { el, previous } = editing;
      editing = null;
      el.removeAttribute("contenteditable");
      el.style.outline = "";
      const text = (el.innerText ?? "").replace(/ /g, " ");
      if (!commit) el.innerText = previous;
      else if (text !== previous) post({ type: "text", src: el.dataset.lvSrc, text, previous });
      refresh();
    };
    const startEdit = (el: HTMLElement) => {
      if (!isTextOnly(el)) return;
      editing = { el, previous: el.innerText };
      el.setAttribute("contenteditable", "plaintext-only");
      if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
      el.style.outline = "none";
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      refresh();
    };

    // ── pointer handlers (capture phase: the app doesn't see clicks in edit mode) ──
    const onMove = (e: PointerEvent) => {
      if (mode !== "edit" || dragging) return;
      const el = srcOf(e.target as Element);
      if (el !== hovered) {
        hovered = el;
        refresh();
        if (el) {
          const i = info(el);
          post({ type: "hover", el: i, src: i.src, tag: i.tag, rect: i.rect });
        } else post({ type: "hover", el: null, src: null });
      }
    };
    const onClick = (e: MouseEvent) => {
      if (mode !== "edit") return;
      const t = e.target as Element;
      if (isUi(t)) return;
      if (editing && editing.el.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      if (editing) finishEdit(true);
      select(srcOf(t));
    };
    const onDblClick = (e: MouseEvent) => {
      if (mode !== "edit") return;
      const el = srcOf(e.target as Element);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      if (selected !== el) select(el);
      startEdit(el);
    };
    const swallow = (e: Event) => {
      if (mode !== "edit") return;
      const t = e.target as Element;
      if (isUi(t)) return;
      if (editing && editing.el.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      if (editing) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finishEdit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finishEdit(false);
        }
        return;
      }
      if (mode === "edit" && e.key === "Escape" && selected) select(null);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (editing && e.target === editing.el) finishEdit(true);
    };

    // ── drag handle: reorder siblings (pointer events) ──
    const horizontalOf = (r: DOMRect, el: HTMLElement) => r.width < window.innerWidth * 0.6 && Math.abs(r.top - el.getBoundingClientRect().top) < r.height / 2;
    const onHandleDown = (e: PointerEvent) => {
      if (!selected) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      handle.style.cursor = "grabbing";
      dragging = { el: selected, siblings: siblingsOf(selected).filter((s) => s !== selected), target: null };
    };
    const onHandleMove = (e: PointerEvent) => {
      if (!dragging) return;
      let best: { el: HTMLElement; before: boolean; d: number; r: DOMRect; horizontal: boolean } | null = null;
      for (const s of dragging.siblings) {
        const r = s.getBoundingClientRect();
        const horizontal = horizontalOf(r, dragging.el);
        const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
        const pos = horizontal ? e.clientX : e.clientY;
        const cx = Math.max(r.left, Math.min(e.clientX, r.right));
        const cy = Math.max(r.top, Math.min(e.clientY, r.bottom));
        const d = Math.hypot(e.clientX - cx, e.clientY - cy);
        if (!best || d < best.d) best = { el: s, before: pos < mid, d, r, horizontal };
      }
      dragging.target = best ? { el: best.el, before: best.before } : null;
      if (best) {
        const { r } = best;
        if (best.horizontal)
          Object.assign(dropLine.style, {
            display: "block",
            left: `${(best.before ? r.left : r.right) - 2}px`,
            top: `${r.top}px`,
            width: "4px",
            height: `${r.height}px`,
          });
        else
          Object.assign(dropLine.style, {
            display: "block",
            left: `${r.left}px`,
            top: `${(best.before ? r.top : r.bottom) - 2}px`,
            width: `${r.width}px`,
            height: "4px",
          });
      } else dropLine.style.display = "none";
    };
    const onHandleUp = (e: PointerEvent) => {
      if (!dragging) return;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      handle.style.cursor = "grab";
      dropLine.style.display = "none";
      const { el, target } = dragging;
      dragging = null;
      if (!target) return;
      const ref = target.el.dataset.lvSrc;
      const position = target.before ? "before" : "after";
      post({ type: "move", src: el.dataset.lvSrc, target: ref, position, ...(target.before ? { beforeSrc: ref } : { afterSrc: ref }) });
    };
    handle.addEventListener("pointerdown", onHandleDown);
    handle.addEventListener("pointermove", onHandleMove);
    handle.addEventListener("pointerup", onHandleUp);
    handle.addEventListener("pointercancel", onHandleUp);

    // ── messages from the editor ──
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const m = e.data as Msg | null;
      if (!m || typeof m !== "object" || (m.__lv !== 1 && m.source !== "levant-editor")) return;
      const src = typeof m.src === "string" ? m.src : null;
      switch (m.type) {
        case "mode": {
          const next: Mode = typeof m.enabled === "boolean" ? (m.enabled ? "edit" : "interact") : m.mode === "interact" ? "interact" : "edit";
          mode = next;
          if (mode === "interact") {
            finishEdit(true);
            hovered = null;
          }
          refresh();
          break;
        }
        case "select": {
          const el = src ? bySrc(src) : null;
          el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          select(el, !!el);
          break;
        }
        case "deselect":
          select(null, false);
          break;
        case "editText": {
          const el = src ? bySrc(src) : null;
          if (el) {
            if (selected !== el) select(el);
            startEdit(el);
          }
          break;
        }
        case "applyClass": {
          const el = src ? bySrc(src) : null;
          if (!el) break;
          for (const c of (m.remove as string[] | undefined) ?? []) el.classList.remove(c);
          for (const c of (m.add as string[] | undefined) ?? []) el.classList.add(c);
          if (typeof m.className === "string") el.setAttribute("class", m.className);
          refresh();
          break;
        }
        case "applyStyle": {
          const el = src ? bySrc(src) : null;
          if (!el || !m.style || typeof m.style !== "object") break;
          for (const [k, v] of Object.entries(m.style as Record<string, string | null>)) {
            const prop = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            if (v == null || v === "") el.style.removeProperty(prop);
            else el.style.setProperty(prop, String(v));
          }
          refresh();
          break;
        }
        case "applyAttr": {
          const el = src ? bySrc(src) : null;
          if (!el || typeof m.name !== "string" || /^on/i.test(m.name)) break;
          if (m.value == null) el.removeAttribute(m.name);
          else el.setAttribute(m.name, String(m.value));
          break;
        }
        case "navigate":
          if (typeof m.path === "string" && m.path.startsWith("/")) location.assign(m.path);
          break;
        case "reload":
          location.reload();
          break;
        case "ping":
          post({ type: "pong", version: VERSION });
          break;
      }
    };

    // ── error forwarding ──
    const onError = (e: ErrorEvent) => reportError("runtime", e.message || String(e.error), e.error?.stack);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string; stack?: string } | string | undefined;
      reportError("unhandledrejection", typeof r === "string" ? r : (r?.message ?? String(r)), typeof r === "object" ? r?.stack : undefined);
    };
    const stringify = (a: unknown) => {
      if (a instanceof Error) return a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    };
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      try {
        const msg = args.map(stringify).join(" ");
        // React/Next dev warnings are noisy; forward real errors only
        if (!/^Warning:|Download the React DevTools|\[Fast Refresh\]|data-lv-src/.test(msg))
          reportError("console", msg, args.find((a): a is Error => a instanceof Error)?.stack);
      } catch {
        /* ignore */
      }
      origConsoleError.apply(console, args as []);
    };
    // Next.js dev error overlay (<nextjs-portal> with a shadow root)
    let overlayTimer: number | undefined;
    const readOverlay = () => {
      for (const portal of Array.from(document.querySelectorAll("nextjs-portal"))) {
        const root = (portal as HTMLElement).shadowRoot;
        if (!root) continue;
        const dialog = root.querySelector(
          "[data-nextjs-dialog], [data-nextjs-dialog-content], .nextjs-container-errors-header, [data-nextjs-error-overlay-nav]",
        );
        if (!dialog) continue;
        const text = (root.querySelector("[data-nextjs-dialog]") ?? dialog).textContent ?? "";
        if (text.trim()) reportError("overlay", text.replace(/\s+/g, " ").trim().slice(0, 4000));
      }
    };
    const mo = new MutationObserver(() => {
      window.clearTimeout(overlayTimer);
      overlayTimer = window.setTimeout(readOverlay, 600);
    });
    mo.observe(document.body, { childList: true, subtree: false });

    // ── navigation reporting (client-side routing) ──
    let lastPath = location.pathname + location.search;
    const navTimer = window.setInterval(() => {
      const p = location.pathname + location.search;
      if (p !== lastPath) {
        lastPath = p;
        select(null, false);
        post({ type: "navigate", path: p });
      }
    }, 300);

    const onScroll = () => refresh();
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("submit", swallow, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("message", onMessage);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    const tick = window.setInterval(refresh, 500); // follow layout changes / HMR updates
    post({ type: "ready", version: VERSION, route: location.pathname, path: location.pathname + location.search });

    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("dblclick", onDblClick, true);
      document.removeEventListener("submit", swallow, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.clearInterval(tick);
      window.clearInterval(navTimer);
      window.clearTimeout(overlayTimer);
      mo.disconnect();
      console.error = origConsoleError;
      for (const n of [hoverBox, selectBox, label, handle, dropLine]) n.remove();
    };
  }, []);
  return null;
}
