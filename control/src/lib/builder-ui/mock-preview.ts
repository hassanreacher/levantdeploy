/**
 * builder-ui: a static page with a minimal reference implementation of the levant-bridge protocol (see bridge.ts).
 * Used only by mock mode (srcdoc iframe) and as a protocol reference for builder-core's real bridge.
 */
export const BRIDGE_REFERENCE_JS = String.raw`(function(){
  if (window.__lvBridge) return; window.__lvBridge = 1;
  var enabled = false, selected = null, editing = null, dragSrc = null;
  var post = function(m){ m.__lv = 1; try { parent.postMessage(m, "*"); } catch(e){} };
  var css = document.createElement("style");
  css.textContent = "[data-lv-hover]{outline:2px dashed rgba(50,145,255,.7)!important;outline-offset:2px}" +
    "[data-lv-selected]{outline:2px solid #3291ff!important;outline-offset:2px}" +
    "[data-lv-drop=before]{box-shadow:0 -3px 0 0 #3291ff!important}[data-lv-drop=after]{box-shadow:0 3px 0 0 #3291ff!important}" +
    "#__lv_handle{position:absolute;z-index:2147483647;display:none;gap:2px;background:#3291ff;color:#fff;font:600 11px system-ui;border-radius:4px;padding:2px 6px;cursor:grab;user-select:none}";
  document.head.appendChild(css);
  var handle = document.createElement("div"); handle.id = "__lv_handle"; handle.draggable = true; handle.textContent = "☰ drag";
  document.body.appendChild(handle);
  var SECTION = /^(SECTION|HEADER|FOOTER|NAV|MAIN|ASIDE)$/;
  function srcEl(t){ while (t && t.nodeType === 1 && !t.getAttribute("data-lv-src")) t = t.parentElement; return t && t.nodeType === 1 ? t : null; }
  function textOnly(el){ if (!el.childNodes.length) return false; for (var i=0;i<el.childNodes.length;i++){ var n=el.childNodes[i]; if (n.nodeType===1 && !/^(BR|B|I|EM|STRONG|SPAN)$/.test(n.tagName)) return false; } return /\S/.test(el.textContent||""); }
  function info(el){
    var cs = getComputedStyle(el), r = el.getBoundingClientRect(), sec = el, parent = el.parentElement ? srcEl(el.parentElement) : null;
    while (sec && !SECTION.test(sec.tagName)) sec = sec.parentElement ? srcEl(sec.parentElement) : null;
    var sib = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, function(c){ return c.getAttribute && c.getAttribute("data-lv-src"); }).length : 1;
    var src = el.getAttribute("data-lv-src");
    return { src: src, tag: el.tagName.toLowerCase(), text: textOnly(el) ? el.textContent : undefined, textEditable: textOnly(el), className: el.getAttribute("class") || "",
      styles: { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color, backgroundColor: cs.backgroundColor, padding: cs.padding, margin: cs.margin, borderRadius: cs.borderRadius, textAlign: cs.textAlign, width: cs.width },
      attrs: { src: el.getAttribute("src") || undefined, alt: el.getAttribute("alt") || undefined, href: el.getAttribute("href") || undefined, target: el.getAttribute("target") || undefined },
      rect: { x: r.left, y: r.top, w: r.width, h: r.height }, sectionSrc: sec ? sec.getAttribute("data-lv-src") : null, parentSrc: parent ? parent.getAttribute("data-lv-src") : null,
      siblings: sib, file: src ? src.replace(/:\d+:\d+$/, "") : undefined };
  }
  function clear(attr){ document.querySelectorAll("["+attr+"]").forEach(function(n){ n.removeAttribute(attr); }); }
  function placeHandle(){ if (!selected || !enabled){ handle.style.display="none"; return; } var r = selected.getBoundingClientRect(); handle.style.display = "flex"; handle.style.left = (r.left + scrollX) + "px"; handle.style.top = Math.max(0, r.top + scrollY - 20) + "px"; }
  function select(el){ clear("data-lv-selected"); selected = el; if (el){ el.setAttribute("data-lv-selected",""); post({ type: "select", el: info(el) }); } else post({ type: "deselect" }); placeHandle(); }
  function stopEdit(){ if (!editing) return; var el = editing; editing = null; el.removeAttribute("contenteditable"); post({ type: "text", src: el.getAttribute("data-lv-src"), text: el.innerText }); }
  function startEdit(el){ if (!textOnly(el)) return; editing = el; el.setAttribute("contenteditable","plaintext-only"); el.focus(); el.addEventListener("blur", stopEdit, { once: true }); }
  document.addEventListener("mouseover", function(e){ if (!enabled) return; clear("data-lv-hover"); var el = srcEl(e.target); if (el && el !== selected) el.setAttribute("data-lv-hover",""); }, true);
  document.addEventListener("click", function(e){ if (!enabled) return; if (editing && editing.contains(e.target)) return; e.preventDefault(); e.stopPropagation(); select(srcEl(e.target)); }, true);
  document.addEventListener("dblclick", function(e){ if (!enabled) return; var el = srcEl(e.target); if (el){ e.preventDefault(); startEdit(el); } }, true);
  document.addEventListener("keydown", function(e){ if (editing && e.key === "Enter" && !e.shiftKey){ e.preventDefault(); editing.blur(); } if (editing && e.key === "Escape") editing.blur(); });
  addEventListener("scroll", placeHandle, true); addEventListener("resize", placeHandle);
  handle.addEventListener("dragstart", function(e){ dragSrc = selected; e.dataTransfer.setData("text/plain", "lv"); e.dataTransfer.effectAllowed = "move"; });
  document.addEventListener("dragover", function(e){ if (!dragSrc) return; var el = srcEl(e.target); clear("data-lv-drop"); if (!el || el === dragSrc || el.parentElement !== dragSrc.parentElement) return; e.preventDefault(); var r = el.getBoundingClientRect(); var horiz = getComputedStyle(el.parentElement).display.indexOf("flex") >= 0 && getComputedStyle(el.parentElement).flexDirection.indexOf("row") === 0; el.setAttribute("data-lv-drop", (horiz ? e.clientX < r.left + r.width/2 : e.clientY < r.top + r.height/2) ? "before" : "after"); });
  document.addEventListener("drop", function(e){ var t = document.querySelector("[data-lv-drop]"); if (!dragSrc || !t) return; e.preventDefault(); var pos = t.getAttribute("data-lv-drop"); clear("data-lv-drop"); post({ type: "move", src: dragSrc.getAttribute("data-lv-src"), target: t.getAttribute("data-lv-src"), position: pos }); if (pos === "before") t.parentElement.insertBefore(dragSrc, t); else t.parentElement.insertBefore(dragSrc, t.nextSibling); dragSrc = null; placeHandle(); });
  document.addEventListener("dragend", function(){ dragSrc = null; clear("data-lv-drop"); });
  function find(src){ return src ? document.querySelector('[data-lv-src="' + String(src).replace(/"/g, '\\"') + '"]') : null; }
  addEventListener("message", function(e){ var m = e.data; if (!m || m.__lv !== 1) return;
    if (m.type === "mode"){ enabled = !!m.enabled; if (!enabled){ clear("data-lv-hover"); clear("data-lv-selected"); selected = null; } placeHandle(); }
    else if (m.type === "select"){ var el = find(m.src); clear("data-lv-selected"); selected = el; if (el){ el.setAttribute("data-lv-selected",""); el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } placeHandle(); }
    else if (m.type === "editText"){ var t = find(m.src); if (t) startEdit(t); }
    else if (m.type === "applyClass"){ var c = find(m.src); if (c){ (m.remove||[]).forEach(function(x){ c.classList.remove(x); }); (m.add||[]).forEach(function(x){ c.classList.add(x); }); if (c === selected) post({ type: "select", el: info(c) }); } }
    else if (m.type === "applyStyle"){ var s = find(m.src); if (s){ for (var k in m.style) s.style[k] = m.style[k] == null ? "" : m.style[k]; } }
    else if (m.type === "applyAttr"){ var a = find(m.src); if (a){ if (m.value == null) a.removeAttribute(m.name); else a.setAttribute(m.name, m.value); } }
    else if (m.type === "navigate"){ location.href = m.path; }
    else if (m.type === "reload"){ location.reload(); }
  });
  addEventListener("error", function(e){ post({ type: "error", message: String(e.message || e.error), stack: e.error && e.error.stack, source: e.filename, route: location.pathname }); });
  addEventListener("unhandledrejection", function(e){ post({ type: "error", message: String(e.reason && e.reason.message || e.reason), stack: e.reason && e.reason.stack, route: location.pathname }); });
  post({ type: "ready", version: 1, route: location.pathname });
})();`;

export const MOCK_PREVIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">

<style>body{font-family:system-ui,sans-serif}</style></head>
<body class="bg-white text-slate-900">
<header data-lv-src="components/navbar.tsx:3:5" class="border-b"><nav data-lv-src="components/navbar.tsx:4:7" class="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
<a data-lv-src="components/navbar.tsx:5:9" href="#" class="text-lg font-semibold">Crumb &amp; Co.</a>
<a data-lv-src="components/navbar.tsx:6:9" href="#order" class="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white">Order now</a></nav></header>
<main data-lv-src="app/page.tsx:3:5">
<section data-lv-src="app/page.tsx:4:7" class="mx-auto max-w-5xl px-6 py-24 text-center">
<h1 data-lv-src="app/page.tsx:5:9" class="text-5xl font-bold tracking-tight">Fresh bread, every morning</h1>
<p data-lv-src="app/page.tsx:6:9" class="mt-4 text-lg text-slate-500">Order online and pick up in 10 minutes.</p>
<img data-lv-src="app/page.tsx:7:9" src="https://picsum.photos/seed/bread/960/400" alt="Bread" class="mx-auto mt-10 w-full rounded-2xl object-cover" style="height:260px"></section>
<section data-lv-src="app/page.tsx:9:7" class="mx-auto grid max-w-5xl gap-6 px-6 pb-20 md:grid-cols-3">
<div data-lv-src="app/page.tsx:10:9" class="rounded-xl border p-6"><h3 data-lv-src="app/page.tsx:11:11" class="font-semibold">Sourdough</h3><p data-lv-src="app/page.tsx:12:11" class="mt-2 text-sm text-slate-500">48-hour fermentation.</p></div>
<div data-lv-src="app/page.tsx:14:9" class="rounded-xl border p-6"><h3 data-lv-src="app/page.tsx:15:11" class="font-semibold">Croissants</h3><p data-lv-src="app/page.tsx:16:11" class="mt-2 text-sm text-slate-500">Butter from local farms.</p></div>
<div data-lv-src="app/page.tsx:18:9" class="rounded-xl border p-6"><h3 data-lv-src="app/page.tsx:19:11" class="font-semibold">Cakes</h3><p data-lv-src="app/page.tsx:20:11" class="mt-2 text-sm text-slate-500">Made to order.</p></div>
</section></main>
<footer data-lv-src="components/footer.tsx:3:5" class="border-t py-8 text-center text-sm text-slate-500">© Crumb &amp; Co.</footer>
<script>${BRIDGE_REFERENCE_JS}</script></body></html>`;
