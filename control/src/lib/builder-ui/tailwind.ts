/**
 * builder-ui: Tailwind class helpers for the visual style panel. The generated apps use Tailwind, so style changes are
 * expressed as class swaps (setClass op: add/remove) — the code stays idiomatic and responsive variants (md:…) are kept.
 */

export type StyleGroup = "fontSize" | "fontWeight" | "textColor" | "bgColor" | "padding" | "margin" | "radius" | "align" | "width";

export const FONT_SIZES = ["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl", "text-5xl", "text-6xl", "text-7xl"] as const;
export const FONT_WEIGHTS = ["font-light", "font-normal", "font-medium", "font-semibold", "font-bold", "font-extrabold", "font-black"] as const;
export const ALIGNS = ["text-left", "text-center", "text-right", "text-justify"] as const;
export const RADII = ["rounded-none", "rounded-sm", "rounded", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-3xl", "rounded-full"] as const;
export const SPACING = ["0", "1", "2", "3", "4", "5", "6", "8", "10", "12", "16", "20", "24"] as const;
export const WIDTHS = ["w-auto", "w-full", "w-fit", "w-1/2", "w-1/3", "w-2/3", "w-3/4", "max-w-sm", "max-w-md", "max-w-lg", "max-w-xl", "max-w-2xl", "max-w-4xl", "max-w-6xl"] as const;

/** Tailwind named colors (the ones that take a shade) */
const COLOR_NAMES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary|secondary|accent|muted|foreground|background|card|popover|destructive|border|input|ring";
const COLOR_RE = new RegExp(`^(?:(?:${COLOR_NAMES})(?:-\\d{2,3})?(?:-foreground)?|black|white|transparent|current|inherit|\\[(?:#|rgb|hsl|oklch|var\\().*\\])(?:/\\d+)?$`);

/** strips responsive / state variants: "md:hover:text-lg" → { variant: "md:hover:", base: "text-lg" } */
export function splitVariant(cls: string): { variant: string; base: string } {
  const i = cls.lastIndexOf(":");
  // arbitrary values may contain ":" inside [...]
  const bracket = cls.indexOf("[");
  if (i < 0 || (bracket >= 0 && i > bracket)) {
    const j = bracket >= 0 ? cls.slice(0, bracket).lastIndexOf(":") : -1;
    return j >= 0 ? { variant: cls.slice(0, j + 1), base: cls.slice(j + 1) } : { variant: "", base: cls };
  }
  return { variant: cls.slice(0, i + 1), base: cls.slice(i + 1) };
}

/** Which style group a (variant-free) class belongs to, or null. */
export function classGroup(base: string): StyleGroup | null {
  if ((FONT_SIZES as readonly string[]).includes(base) || /^text-\[\d+(\.\d+)?(px|rem|em)\]$/.test(base)) return "fontSize";
  if ((ALIGNS as readonly string[]).includes(base)) return "align";
  if (base.startsWith("text-") && COLOR_RE.test(base.slice(5))) return "textColor";
  if ((FONT_WEIGHTS as readonly string[]).includes(base) || base === "font-thin") return "fontWeight";
  if (base.startsWith("bg-") && COLOR_RE.test(base.slice(3))) return "bgColor";
  if (/^p[xytrbl]?-(\d+(\.5)?|px|\[.+\])$/.test(base)) return "padding";
  if (/^-?m[xytrbl]?-(\d+(\.5)?|px|auto|\[.+\])$/.test(base)) return "margin";
  if (/^rounded(-(none|sm|md|lg|xl|2xl|3xl|full|\[.+\]))?$/.test(base)) return "radius";
  if (/^(max-)?w-/.test(base)) return "width";
  return null;
}

export function splitClasses(className: string | null | undefined): string[] {
  return (className ?? "").split(/\s+/).filter(Boolean);
}

/** Current (base-variant) class of a group, e.g. current(cls, "fontSize") → "text-xl" */
export function currentOf(className: string | null | undefined, group: StyleGroup): string | null {
  for (const c of splitClasses(className)) {
    const { variant, base } = splitVariant(c);
    if (!variant && classGroup(base) === group) return base;
  }
  return null;
}

/**
 * Replace the un-prefixed classes of a group with `next` (null = remove). Responsive/state variants are kept.
 * For padding/margin, `axis` limits the replacement to p-/px-/py- … of the same axis.
 */
export function swapClass(className: string | null | undefined, group: StyleGroup, next: string | null): { add: string[]; remove: string[]; className: string } {
  const list = splitClasses(className);
  const axisOf = (b: string) => /^-?[pm]([xytrbl]?)-/.exec(b)?.[1] ?? "";
  const nextAxis = next && (group === "padding" || group === "margin") ? axisOf(next) : null;
  const remove: string[] = [];
  const kept: string[] = [];
  for (const c of list) {
    const { variant, base } = splitVariant(c);
    let match = !variant && classGroup(base) === group;
    if (match && nextAxis !== null) {
      const a = axisOf(base);
      // "p-4" replaces every padding axis; "px-4" replaces px/pl/pr; "py-4" replaces py/pt/pb
      match = nextAxis === "" || a === nextAxis || (nextAxis === "x" && (a === "l" || a === "r")) || (nextAxis === "y" && (a === "t" || a === "b"));
    }
    if (match && c !== next) remove.push(c);
    else if (!(match && c === next)) kept.push(c);
  }
  const add = next && !list.includes(next) ? [next] : [];
  const out = [...kept, ...(next ? [next] : [])];
  return { add, remove, className: out.join(" ") };
}

/** "#ff0000" → "text-[#ff0000]" etc. Palette tokens (e.g. "primary") stay as Tailwind names. */
export function colorClass(prefix: "text" | "bg", value: string): string {
  const v = value.trim();
  if (/^#|^rgb|^hsl|^oklch|^var\(/.test(v)) return `${prefix}-[${v.replace(/\s+/g, "")}]`;
  return `${prefix}-${v}`;
}

export const ALIGN_LABEL: Record<(typeof ALIGNS)[number], string> = { "text-left": "Left", "text-center": "Center", "text-right": "Right", "text-justify": "Justify" };
