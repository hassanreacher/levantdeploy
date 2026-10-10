"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  Copy,
  ImageUp,
  Link2,
  Loader2,
  MessageSquarePlus,
  Plus,
  Redo2,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { builderApi } from "@/lib/builder-ui/api";
import { elementLabel, parseSrc } from "@/lib/builder-ui/bridge";
import { ALIGNS, FONT_SIZES, FONT_WEIGHTS, RADII, SPACING, WIDTHS, colorClass, currentOf, swapClass, type StyleGroup } from "@/lib/builder-ui/tailwind";
import { errMessage, useEditor } from "./context";
import { AddSectionDrawer } from "./add-section";
import { modKey } from "./shortcuts";

/** Tailwind palette offered by default (+ theme tokens of the app + custom color). */
const PALETTE: { name: string; hex: string }[] = [
  { name: "white", hex: "#ffffff" },
  { name: "black", hex: "#000000" },
  { name: "slate-500", hex: "#64748b" },
  { name: "slate-900", hex: "#0f172a" },
  { name: "red-500", hex: "#ef4444" },
  { name: "amber-500", hex: "#f59e0b" },
  { name: "emerald-500", hex: "#10b981" },
  { name: "sky-500", hex: "#0ea5e9" },
  { name: "indigo-500", hex: "#6366f1" },
  { name: "pink-500", hex: "#ec4899" },
];
const THEME_TOKENS = ["primary", "secondary", "accent", "muted", "foreground", "background"];

export function Inspector() {
  const ed = useEditor();
  const toast = useToast();
  const el = ed.selection!;
  const where = parseSrc(el.src);
  const [cls, setCls] = useState(el.className ?? "");
  const [text, setText] = useState(el.text ?? "");
  const [href, setHref] = useState(el.attrs?.href ?? "");
  const [alt, setAlt] = useState(el.attrs?.alt ?? "");
  const [drawer, setDrawer] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCls(el.className ?? "");
    setText(el.text ?? "");
    setHref(el.attrs?.href ?? "");
    setAlt(el.attrs?.alt ?? "");
  }, [el]);

  const deselect = () => {
    ed.setSelection(null);
    ed.toBridge({ type: "select", src: null });
  };

  const setGroup = async (group: StyleGroup, next: string | null, label: string) => {
    const r = swapClass(cls, group, next);
    if (!r.add.length && !r.remove.length) return;
    setCls(r.className);
    ed.toBridge({ type: "applyClass", src: el.src, add: r.add, remove: r.remove });
    await ed.applyOps([{ op: "setClass", src: el.src, add: r.add, remove: r.remove }], label);
  };

  const commitText = async () => {
    if (text === (el.text ?? "")) return;
    await ed.applyOps([{ op: "setText", src: el.src, text }], "Edit text");
  };

  const setAttr = async (name: string, value: string | null, label: string) => {
    ed.toBridge({ type: "applyAttr", src: el.src, name, value });
    await ed.applyOps([{ op: "setAttr", src: el.src, name, value }], label);
  };

  const replaceImage = async (f: File) => {
    if (!f.type.startsWith("image/")) return toast.error("Choose an image file");
    if (f.size > 10 * 1024 * 1024) return toast.error("Image too large", "The limit is 10 MB");
    setUploading(true);
    try {
      // builder-core stores it in the app's public/uploads (committed) and returns the URL to use in <img src>
      const r = await builderApi().upload(ed.project.id, f);
      await setAttr("src", r.url, "Replace image");
    } catch (e) {
      toast.error("Upload failed", errMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const isImg = el.tag === "img";
  const isLink = el.tag === "a" || !!el.attrs?.href;
  const palette = useMemo(() => {
    const theme = ed.project.settings.theme?.colors ?? {};
    return { tokens: Object.keys(theme).length ? Object.keys(theme) : THEME_TOKENS, theme };
  }, [ed.project.settings.theme]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="inspector">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button size="icon-sm" variant="ghost" onClick={deselect} aria-label="Back to chat" title="Back to chat (Esc)">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{elementLabel(el)}</p>
          {where && (
            <p className="truncate font-mono text-[10.5px] text-subtle" title={el.src}>
              {where.file}:{where.line}
            </p>
          )}
        </div>
        {ed.editing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
        <Button size="icon-sm" variant="ghost" onClick={() => void ed.undo()} disabled={!ed.canUndo || ed.editing} aria-label="Undo" title={`Undo (${modKey()}Z)`}>
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => void ed.redo()} disabled={!ed.canRedo || ed.editing} aria-label="Redo" title={`Redo (${modKey()}⇧Z)`}>
          <Redo2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="secondary" leftIcon={<Copy className="h-3.5 w-3.5" />} onClick={() => void ed.applyOps([{ op: "duplicate", src: el.src }], "Duplicate")} disabled={ed.editing}>
            Duplicate
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={async () => {
              if (await ed.applyOps([{ op: "delete", src: el.src }], `Delete ${elementLabel(el).toLowerCase()}`)) deselect();
            }}
            disabled={ed.editing}
            className="hover:text-danger"
          >
            Delete
          </Button>
          <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDrawer(true)}>
            Section
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          leftIcon={<MessageSquarePlus className="h-3.5 w-3.5" />}
          onClick={() => {
            const name = `${elementLabel(el)}${el.text ? ` “${el.text.slice(0, 40)}”` : ""}`;
            ed.prefill(`About the ${name}: `, [{ kind: "element", src: el.src, name, text: el.text?.slice(0, 500) }]);
            deselect();
          }}
          data-testid="ask-ai-element"
        >
          Ask AI about this element
        </Button>

        {el.textEditable && (
          <Group title="Text" icon={<Type className="h-3.5 w-3.5" />}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void commitText()} rows={Math.min(6, Math.max(2, Math.ceil(text.length / 38)))} aria-label="Text" className="text-[13px]" />
            <p className="text-[11.5px] text-subtle">Or double-click the text in the preview to type in place.</p>
          </Group>
        )}

        {isImg && (
          <Group title="Image" icon={<ImageUp className="h-3.5 w-3.5" />}>
            {el.attrs?.src && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={el.attrs.src} alt="" className="max-h-32 w-full rounded-md border border-border bg-bg-subtle object-contain" />
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void replaceImage(e.target.files[0])} />
            <Button size="sm" variant="secondary" className="w-full" loading={uploading} leftIcon={<ImageUp className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()}>
              Replace image
            </Button>
            <p className="text-[11.5px] text-subtle">The image is saved in your app (public/uploads) and published with it.</p>
            <Field label="Alt text">
              <Input value={alt} onChange={(e) => setAlt(e.target.value)} onBlur={() => alt !== (el.attrs?.alt ?? "") && void setAttr("alt", alt, "Edit alt text")} placeholder="Describe the image" />
            </Field>
          </Group>
        )}

        {isLink && (
          <Group title="Link" icon={<Link2 className="h-3.5 w-3.5" />}>
            <Input value={href} onChange={(e) => setHref(e.target.value)} onBlur={() => href !== (el.attrs?.href ?? "") && void setAttr("href", href, "Edit link")} placeholder="/about or https://…" className="font-mono text-[12px]" aria-label="Link URL" />
            <label className="flex items-center justify-between text-[12.5px] text-muted">
              Open in a new tab
              <Switch size="sm" checked={el.attrs?.target === "_blank"} onCheckedChange={(v) => void setAttr("target", v ? "_blank" : null, v ? "Open link in new tab" : "Open link in same tab")} />
            </label>
          </Group>
        )}

        <Group title="Typography">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Size">
              <ClassSelect value={currentOf(cls, "fontSize")} options={FONT_SIZES} format={(v) => v.replace("text-", "")} onChange={(v) => void setGroup("fontSize", v, "Font size")} hint={el.styles?.fontSize} />
            </Field>
            <Field label="Weight">
              <ClassSelect value={currentOf(cls, "fontWeight")} options={FONT_WEIGHTS} format={(v) => v.replace("font-", "")} onChange={(v) => void setGroup("fontWeight", v, "Font weight")} hint={el.styles?.fontWeight} />
            </Field>
          </div>
          <Field label="Alignment">
            <div className="grid grid-cols-4 gap-1 rounded-md border border-border p-0.5" role="radiogroup" aria-label="Text alignment">
              {ALIGNS.map((a, i) => {
                const Icon = [AlignLeft, AlignCenter, AlignRight, AlignJustify][i]!;
                const on = currentOf(cls, "align") === a;
                return (
                  <button key={a} role="radio" aria-checked={on} aria-label={a.replace("text-", "")} onClick={() => void setGroup("align", on ? null : a, "Alignment")} className={cn("flex h-7 items-center justify-center rounded text-muted", on ? "bg-surface-2 text-fg" : "hover:text-fg")}>
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Text color">
            <ColorPicker prefix="text" current={currentOf(cls, "textColor")} tokens={palette.tokens} themeColors={palette.theme} onPick={(c) => void setGroup("textColor", c, "Text color")} />
          </Field>
        </Group>

        <Group title="Box">
          <Field label="Background">
            <ColorPicker prefix="bg" current={currentOf(cls, "bgColor")} tokens={palette.tokens} themeColors={palette.theme} onPick={(c) => void setGroup("bgColor", c, "Background color")} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Padding">
              <ClassSelect value={currentOf(cls, "padding")} options={SPACING.map((s) => `p-${s}`)} format={(v) => v.replace(/^p-/, "")} onChange={(v) => void setGroup("padding", v, "Padding")} hint={el.styles?.padding} />
            </Field>
            <Field label="Margin (vertical)">
              <ClassSelect value={currentOf(cls, "margin")} options={SPACING.map((s) => `my-${s}`)} format={(v) => v.replace(/^my-/, "")} onChange={(v) => void setGroup("margin", v, "Margin")} hint={el.styles?.margin} />
            </Field>
            <Field label="Corner radius">
              <ClassSelect value={currentOf(cls, "radius")} options={RADII} format={(v) => (v === "rounded" ? "default" : v.replace("rounded-", ""))} onChange={(v) => void setGroup("radius", v, "Corner radius")} hint={el.styles?.borderRadius} />
            </Field>
            <Field label="Width">
              <ClassSelect value={currentOf(cls, "width")} options={WIDTHS} format={(v) => v.replace(/^w-/, "").replace("max-w-", "max ")} onChange={(v) => void setGroup("width", v, "Width")} hint={el.styles?.width} />
            </Field>
          </div>
        </Group>

        <details className="text-[12px]">
          <summary className="cursor-pointer text-subtle hover:text-fg">Classes</summary>
          <p className="mt-2 break-words rounded-md border border-border bg-bg-subtle p-2 font-mono text-[11px] text-muted">{cls || "—"}</p>
        </details>
      </div>
      <AddSectionDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}

function Group({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </label>
  );
}

function ClassSelect({ value, options, format, onChange, hint }: { value: string | null; options: readonly string[]; format: (v: string) => string; onChange: (v: string | null) => void; hint?: string }) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-8 w-full rounded-md border border-border bg-bg px-2 text-[12.5px] outline-none focus:border-border-strong"
    >
      <option value="">{hint ? `Default (${hint.length > 14 ? `${hint.slice(0, 14)}…` : hint})` : "Default"}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {format(o)}
        </option>
      ))}
      {value && !options.includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}

function ColorPicker({ prefix, current, tokens, themeColors, onPick }: { prefix: "text" | "bg"; current: string | null; tokens: string[]; themeColors: Record<string, string>; onPick: (c: string | null) => void }) {
  const [custom, setCustom] = useState("#3291ff");
  const sw = (cls: string, color: string | null, label: string) =>
    color ? (
      <button
        key={cls}
        type="button"
        onClick={() => onPick(current === cls ? null : cls)}
        title={label}
        aria-label={label}
        aria-pressed={current === cls}
        className={cn("h-6 w-6 rounded-full border border-border-strong transition-transform hover:scale-110", current === cls && "ring-2 ring-accent ring-offset-2 ring-offset-bg")}
        style={{ background: color }}
      />
    ) : (
      // theme token without a known value (resolved by the app's CSS variables)
      <button
        key={cls}
        type="button"
        onClick={() => onPick(current === cls ? null : cls)}
        aria-pressed={current === cls}
        title={`Theme color “${label}”`}
        className={cn("h-6 rounded-full border px-2 text-[11px] transition-colors", current === cls ? "border-accent bg-accent/10 text-fg" : "border-border text-muted hover:border-border-strong hover:text-fg")}
      >
        {label}
      </button>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" aria-label="Theme colors">
        {tokens.map((t) => sw(`${prefix}-${t}`, themeColors[t] ?? null, t))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Palette">
        {PALETTE.map((p) => sw(`${prefix}-${p.name}`, p.hex, p.name))}
        <label className="relative flex h-6 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-muted hover:text-fg" title="Custom color">
          <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} onBlur={() => onPick(colorClass(prefix, custom))} className="h-4 w-4 cursor-pointer rounded-full border-0 bg-transparent p-0" aria-label="Custom color" />
          Custom
        </label>
        {current && (
          <button type="button" onClick={() => onPick(null)} className="text-[11px] text-subtle hover:text-fg">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
