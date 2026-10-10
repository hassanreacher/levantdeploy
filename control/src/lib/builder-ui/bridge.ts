/**
 * builder-ui: postMessage protocol between the editor and the `levant-bridge` script injected (dev only) into the
 * preview app. Every message carries `__lv: 1`. The editor only accepts messages whose `event.source` is the
 * preview iframe's window and whose origin is the preview origin.
 *
 * bridge → editor: ready | navigate | hover | select | text | move | error | deselect
 * editor → bridge: mode | select | editText | applyStyle | applyClass | navigate | reload | highlight
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type ElementInfo = {
  /** data-lv-src "path:line:col" */
  src: string;
  tag: string;
  text?: string;
  /** text-only node → inline editing allowed */
  textEditable?: boolean;
  className?: string;
  /** computed styles (subset) */
  styles?: Partial<Record<"fontSize" | "fontWeight" | "color" | "backgroundColor" | "padding" | "margin" | "borderRadius" | "textAlign" | "width", string>>;
  attrs?: Partial<Record<"src" | "alt" | "href" | "target", string>>;
  rect?: Rect;
  /** nearest section-level ancestor (section/header/footer/nav/main > *) — target for "Add section" */
  sectionSrc?: string | null;
  parentSrc?: string | null;
  /** number of siblings with data-lv-src (drag & drop only makes sense when > 1) */
  siblings?: number;
  /** component file the element lives in (from src) */
  file?: string;
};

export type BridgeToEditor =
  | { __lv: 1; type: "ready"; version?: number; route?: string }
  | { __lv: 1; type: "navigate"; path: string }
  | { __lv: 1; type: "hover"; el: ElementInfo | null }
  | { __lv: 1; type: "select"; el: ElementInfo }
  | { __lv: 1; type: "deselect" }
  | { __lv: 1; type: "text"; src: string; text: string }
  | { __lv: 1; type: "move"; src: string; target: string; position: "before" | "after" }
  | { __lv: 1; type: "error"; message: string; stack?: string; source?: string; route?: string };

export type EditorToBridge =
  | { __lv: 1; type: "mode"; enabled: boolean }
  | { __lv: 1; type: "select"; src: string | null }
  | { __lv: 1; type: "editText"; src: string }
  | { __lv: 1; type: "applyStyle"; src: string; style: Record<string, string | null> }
  | { __lv: 1; type: "applyClass"; src: string; add?: string[]; remove?: string[] }
  | { __lv: 1; type: "applyAttr"; src: string; name: string; value: string | null }
  | { __lv: 1; type: "navigate"; path: string }
  | { __lv: 1; type: "reload" };

type Distribute<T> = T extends unknown ? Omit<T, "__lv"> : never;
export type EditorMessage = Distribute<EditorToBridge>;

export function isBridgeMessage(data: unknown): data is BridgeToEditor {
  return !!data && typeof data === "object" && (data as { __lv?: unknown }).__lv === 1 && typeof (data as { type?: unknown }).type === "string";
}

/** "app/page.tsx:12:5" → { file, line, col } */
export function parseSrc(src: string): { file: string; line: number; col: number } | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(src);
  if (!m) return null;
  return { file: m[1]!, line: Number(m[2]), col: Number(m[3]) };
}

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function postToBridge(win: Window | null | undefined, origin: string, msg: EditorMessage) {
  if (!win) return;
  win.postMessage({ __lv: 1, ...msg }, origin || "*");
}

/** Human label for an element ("Heading", "Button", "Image", …). */
export function elementLabel(el: Pick<ElementInfo, "tag">): string {
  const t = el.tag.toLowerCase();
  const map: Record<string, string> = {
    h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", h5: "Heading 5", h6: "Heading 6",
    p: "Paragraph", span: "Text", a: "Link", button: "Button", img: "Image", section: "Section", header: "Header", footer: "Footer",
    nav: "Navigation", div: "Container", ul: "List", ol: "List", li: "List item", form: "Form", input: "Input", textarea: "Text area",
    label: "Label", main: "Main", article: "Article", aside: "Aside", figure: "Figure", video: "Video", svg: "Icon",
  };
  return map[t] ?? `<${t}>`;
}
