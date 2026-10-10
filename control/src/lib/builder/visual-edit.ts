/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs/promises";
import path from "node:path";
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import { commitAll, withRepoLock, type CommitAuthor } from "./git";
import { repoDir, fixOwnership } from "./workspace";
import { safeRelPath } from "./files";
import { componentName, readLibraryComponent } from "./template";

/**
 * Visual edits as AST transforms (builder-core). Elements are addressed by the `data-lv-src="relpath:line:col"`
 * attribute the preview's dev-only loader adds (line/col 1-based = position of the JSX opening `<`).
 *
 * Ops (aliases accepted for the spec names):
 *   setText    { src, text }                                   JSX text child(ren) of the element
 *   setClass   { src, add?, remove?, className? }              (alias setClassName { src, classes }) — tailwind-aware merge
 *   setStyle   { src, style: { prop: value | null } }          inline style object
 *   setAttr    { src, name, value | null }                     img src/alt, link href, … (no on* handlers)
 *   move       { src, target, position: before|after }         (alias { src, beforeSrc } / { src, afterSrc }) — same parent only
 *   duplicate  { src }
 *   delete     { src }                                         (alias remove) — prunes imports left unused
 *   insert     { target, position: before|after|inside|inside-start|inside-end, component }
 *              (alias insertComponent { targetSrc, position, componentId }) — copies builder-template/library/<id>.tsx to
 *              components/sections/<id>.tsx (once) and imports it
 * Pipeline per request: group ops by file → parse once (babel + recast, original formatting kept) → resolve every
 * target by its ORIGINAL position → mutate → print → prettier (project config) → write → one commit
 * "visual edit: …". Positions of new/moved elements are returned as `newSrc`.
 * Worker-safe.
 */

export class VisualEditError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

// ───────────────────────────── op types ─────────────────────────────

export type InsertPosition = "before" | "after" | "inside" | "inside-start" | "inside-end";
export type VisualOp =
  | { op: "setText"; src: string; text: string }
  | { op: "setClass"; src: string; add?: string[]; remove?: string[]; className?: string }
  | { op: "setStyle"; src: string; style: Record<string, string | number | null> }
  | { op: "setAttr"; src: string; name: string; value: string | null }
  | { op: "move"; src: string; target: string; position: "before" | "after" }
  | { op: "duplicate"; src: string }
  | { op: "delete"; src: string }
  | { op: "insert"; target: string; position: InsertPosition; component: string };

export type OpResult = { op: VisualOp["op"]; src?: string; file: string; newSrc?: string | null; description: string };

/** Accepts the UI shapes and the spec aliases; validates basic fields. */
export function normalizeOp(raw: unknown): VisualOp {
  const o = (raw ?? {}) as Record<string, any>;
  const str = (v: unknown, name: string, max = 500) => {
    if (typeof v !== "string" || !v || v.length > max) throw new VisualEditError(`"${name}" is required`, 400);
    return v;
  };
  switch (o.op) {
    case "setText":
      if (typeof o.text !== "string" || o.text.length > 20_000) throw new VisualEditError('"text" is required', 400);
      return { op: "setText", src: str(o.src, "src"), text: o.text };
    case "setClass":
    case "setClassName": {
      const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").flatMap((x) => x.split(/\s+/)).filter(Boolean) : undefined);
      const className = typeof o.className === "string" ? o.className : typeof o.classes === "string" ? o.classes : undefined;
      if (className === undefined && !arr(o.add)?.length && !arr(o.remove)?.length) throw new VisualEditError("setClass needs className, add or remove", 400);
      if (className && className.length > 4000) throw new VisualEditError("className is too long", 400);
      return { op: "setClass", src: str(o.src, "src"), add: arr(o.add), remove: arr(o.remove), className };
    }
    case "setStyle":
      if (!o.style || typeof o.style !== "object") throw new VisualEditError('"style" is required', 400);
      return { op: "setStyle", src: str(o.src, "src"), style: o.style };
    case "setAttr":
      if (o.value !== null && typeof o.value !== "string") throw new VisualEditError('"value" must be a string or null', 400);
      return { op: "setAttr", src: str(o.src, "src"), name: str(o.name, "name", 64), value: o.value };
    case "move": {
      const target = o.target ?? o.beforeSrc ?? o.afterSrc;
      const position = o.position ?? (o.beforeSrc ? "before" : o.afterSrc ? "after" : undefined);
      if (position !== "before" && position !== "after") throw new VisualEditError('move needs position "before" or "after"', 400);
      return { op: "move", src: str(o.src, "src"), target: str(target, "target"), position };
    }
    case "duplicate":
      return { op: "duplicate", src: str(o.src, "src") };
    case "delete":
    case "remove":
      return { op: "delete", src: str(o.src, "src") };
    case "insert":
    case "insertComponent": {
      const position = (o.position ?? "after") as InsertPosition;
      if (!["before", "after", "inside", "inside-start", "inside-end"].includes(position)) throw new VisualEditError("Invalid insert position", 400);
      return { op: "insert", target: str(o.target ?? o.targetSrc, "target"), position, component: str(o.component ?? o.componentId, "component", 60) };
    }
    default:
      throw new VisualEditError(`Unknown visual edit op "${String(o.op)}"`, 400);
  }
}

// ───────────────────────────── src addressing ─────────────────────────────

export type SrcRef = { file: string; line: number; col: number };

export function parseSrc(src: string): SrcRef {
  const m = /^(.+):(\d+):(\d+)$/.exec(src.trim());
  if (!m) throw new VisualEditError(`Invalid element reference "${src}"`, 400);
  const file = safeRelPath(m[1]!);
  if (!/\.(tsx|jsx)$/.test(file)) throw new VisualEditError("Only .tsx/.jsx files can be edited visually", 400);
  return { file, line: Number(m[2]), col: Number(m[3]) };
}

export const formatSrc = (r: SrcRef) => `${r.file}:${r.line}:${r.col}`;

// ───────────────────────────── parsing / printing ─────────────────────────────

const b = recast.types.builders;

const babelOptions = { sourceType: "module" as const, plugins: ["jsx" as const, "typescript" as const], tokens: true, errorRecovery: false };

export function parseCode(code: string): any {
  try {
    return recast.parse(code, { parser: { parse: (s: string) => babelParse(s, babelOptions) } });
  } catch (e) {
    throw new VisualEditError(`The file has a syntax error and can't be edited visually: ${(e as Error).message}`);
  }
}

type Visit = (node: any, parent: any, key: string | null, index: number | null) => void | false;

/** Depth-first walk over a babel/recast AST (skips location/token metadata). */
export function walk(node: any, fn: Visit, parent: any = null, key: string | null = null, index: number | null = null) {
  if (!node || typeof node.type !== "string") return;
  if (fn(node, parent, key, index) === false) return;
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end" || k === "tokens" || k === "comments" || k === "original" || k === "extra" || k === "range") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i].type === "string") walk(v[i], fn, node, k, i);
    } else if (v && typeof v.type === "string") walk(v, fn, node, k, null);
  }
}

type Found = { node: any; parent: any; key: string | null };

/** JSXElement whose opening `<` is at line:col (1-based col). */
export function findElement(ast: any, line: number, col: number): Found | null {
  let hit: Found | null = null;
  walk(ast.program, (n, parent, key) => {
    if (hit) return false;
    if (n.type === "JSXElement" && n.loc && n.loc.start.line === line && n.loc.start.column + 1 === col) {
      hit = { node: n, parent, key };
      return false;
    }
  });
  return hit;
}

/** Parent node + children array of an element when it sits directly in JSX children (not a root / expression). */
function jsxContainer(ast: any, el: any): { parent: any; children: any[] } | null {
  let res: { parent: any; children: any[] } | null = null;
  walk(ast.program, (n) => {
    if (res) return false;
    if ((n.type === "JSXElement" || n.type === "JSXFragment") && Array.isArray(n.children) && n.children.includes(el)) {
      res = { parent: n, children: n.children };
      return false;
    }
  });
  return res;
}

function elementName(el: any): string {
  const n = el.openingElement?.name;
  if (!n) return "element";
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return `${elementName({ openingElement: { name: n.object } })}.${n.property.name}`;
  return "element";
}

function getAttr(el: any, name: string): any | null {
  return (el.openingElement.attributes as any[]).find((a) => a.type === "JSXAttribute" && a.name?.name === name) ?? null;
}

function removeAttr(el: any, name: string) {
  el.openingElement.attributes = (el.openingElement.attributes as any[]).filter((a) => !(a.type === "JSXAttribute" && a.name?.name === name));
}

function setStringAttr(el: any, name: string, value: string) {
  const attr = getAttr(el, name);
  const lit = b.stringLiteral(value);
  if (attr) attr.value = needsExpression(value) ? b.jsxExpressionContainer(lit) : lit;
  else el.openingElement.attributes.push(b.jsxAttribute(b.jsxIdentifier(name), needsExpression(value) ? b.jsxExpressionContainer(lit) : lit));
}

/** JSX attribute string literals can't contain `"` + newlines safely → use an expression container. */
const needsExpression = (v: string) => /["\n\\]/.test(v);

/** Deep clone without positions / original refs (recast pretty-prints it). */
export function cloneNode<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => cloneNode(n)) as unknown as T;
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node as any)) {
    if (k === "loc" || k === "start" || k === "end" || k === "original" || k === "tokens" || k === "range") continue;
    out[k] = typeof v === "object" && v !== null ? cloneNode(v) : v;
  }
  return out;
}

const MARK = "data-lv-new";

function mark(el: any) {
  el.openingElement.attributes.push(b.jsxAttribute(b.jsxIdentifier(MARK), b.stringLiteral("1")));
}

// ───────────────────────────── tailwind-aware class merge ─────────────────────────────

const DISPLAY = new Set(["block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid", "hidden", "contents", "table", "flow-root", "list-item"]);
const POSITION = new Set(["static", "fixed", "absolute", "relative", "sticky"]);
const SIZES = new Set(["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const ALIGN = new Set(["left", "center", "right", "justify", "start", "end"]);
const WEIGHTS = new Set(["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"]);
const DECORATION = new Set(["underline", "overline", "line-through", "no-underline"]);
const TRANSFORM = new Set(["uppercase", "lowercase", "capitalize", "normal-case"]);
const FONT_STYLE = new Set(["italic", "not-italic"]);
const BORDER_STYLE = new Set(["solid", "dashed", "dotted", "double", "hidden", "none"]);

function splitVariants(token: string): { variants: string; base: string } {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ":" && depth === 0) last = i;
  }
  return last < 0 ? { variants: "", base: token } : { variants: token.slice(0, last + 1), base: token.slice(last + 1) };
}

const isLength = (v: string) => /^\[?-?[\d.]+(px|rem|em|%|vh|vw|ch)?\]?$/.test(v) || /^\[(length|calc|var)/.test(v);

/** Conflict group of a tailwind class ("md:text-lg" → "md:|text-size"). Classes in the same group override each other. */
export function classGroup(token: string): string {
  const { variants, base: raw } = splitVariants(token);
  const base = raw.replace(/^!/, "").replace(/^-/, "");
  const g = (() => {
    if (DISPLAY.has(base)) return "display";
    if (POSITION.has(base)) return "position";
    if (DECORATION.has(base)) return "text-decoration";
    if (TRANSFORM.has(base)) return "text-transform";
    if (FONT_STYLE.has(base)) return "font-style";
    if (base === "truncate") return "text-overflow";
    if (base.startsWith("text-")) {
      const v = base.slice(5);
      if (SIZES.has(v) || isLength(v)) return "text-size";
      if (ALIGN.has(v)) return "text-align";
      if (/^(wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(v)) return "text-wrap";
      return "text-color";
    }
    if (base.startsWith("font-")) return WEIGHTS.has(base.slice(5)) || /^\[\d+\]$/.test(base.slice(5)) ? "font-weight" : "font-family";
    if (base.startsWith("bg-")) {
      const v = base.slice(3);
      if (/^(gradient-|none$|\[url)/.test(v)) return "bg-image";
      if (/^(cover|contain|auto)$/.test(v)) return "bg-size";
      if (/^(center|top|bottom|left|right|left-top|left-bottom|right-top|right-bottom)$/.test(v)) return "bg-position";
      if (/^(repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/.test(v)) return "bg-repeat";
      if (/^(fixed|local|scroll)$/.test(v)) return "bg-attachment";
      if (/^clip-/.test(v)) return "bg-clip";
      return "bg-color";
    }
    if (base === "border" || /^border-(\d+|\[[\d.]+px\])$/.test(base)) return "border-width";
    let m = /^border-([xytrblse])(?:-(\d+|\[.+\]))?$/.exec(base);
    if (m) return `border-width-${m[1]}`;
    if (base.startsWith("border-") && BORDER_STYLE.has(base.slice(7))) return "border-style";
    if (base.startsWith("border-")) return "border-color";
    m = /^rounded(?:-(t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?(?:-.+)?$/.exec(base);
    if (m) return `rounded-${m[1] ?? "all"}`;
    m = /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|w|h|min-w|max-w|min-h|max-h|size|gap|gap-x|gap-y|space-x|space-y|top|right|bottom|left|inset|inset-x|inset-y|z|opacity|leading|tracking|order|basis|grow|shrink|columns|aspect|cursor|object|overflow|overflow-x|overflow-y|grid-cols|grid-rows|col-span|row-span|col-start|col-end|line-clamp|duration|delay|ease|scale|rotate|translate-x|translate-y|blur|brightness|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|underline-offset|indent|align|whitespace|break|list|place-items|place-content|place-self|content|items|justify|justify-items|self)(?:-(.+))?$/.exec(base);
    if (m) {
      const prefix = m[1]!;
      if (prefix === "ring" || prefix === "outline") return isLength(m[2] ?? "1") || !m[2] ? `${prefix}-width` : `${prefix}-color`;
      if (prefix === "shadow") return "shadow";
      return prefix;
    }
    if (base === "shadow" || base.startsWith("shadow-")) return "shadow";
    if (/^flex-(row|col)(-reverse)?$/.test(base)) return "flex-direction";
    if (/^flex-(wrap|wrap-reverse|nowrap)$/.test(base)) return "flex-wrap";
    if (/^flex-(1|auto|initial|none|\[.+\])$/.test(base)) return "flex";
    if (base === "grow" || base === "shrink") return base;
    if (base === "container") return "container";
    return `x:${base}`; // unknown: only exact duplicates conflict
  })();
  return `${variants}|${g}`;
}

/** Merge tailwind classes: remove `remove`, then add `add` (each added class replaces conflicting existing ones). */
export function mergeClasses(existing: string, add: string[] = [], remove: string[] = []): string {
  let tokens = existing.split(/\s+/).filter(Boolean);
  const rm = new Set(remove);
  tokens = tokens.filter((t) => !rm.has(t));
  for (const a of add) {
    const grp = classGroup(a);
    tokens = tokens.filter((t) => t !== a && classGroup(t) !== grp);
    tokens.push(a);
  }
  return tokens.join(" ");
}

// ───────────────────────────── single-file transforms ─────────────────────────────

type FileCtx = { ast: any; file: string; imports: Array<{ name: string; from: string }>; prune: Set<string>; marks: Array<{ el: any; result: OpResult }> };

function textOf(el: any): string {
  return (el.children as any[])
    .map((c) => (c.type === "JSXText" ? c.value : c.type === "JSXExpressionContainer" && c.expression.type === "StringLiteral" ? c.expression.value : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function applySetText(el: any, text: string) {
  const isTextChild = (c: any) =>
    c.type === "JSXText" || (c.type === "JSXExpressionContainer" && (c.expression.type === "StringLiteral" || (c.expression.type === "TemplateLiteral" && c.expression.expressions.length === 0)));
  const meaningful = (el.children as any[]).filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  const textChildren = meaningful.filter(isTextChild);
  const others = meaningful.filter((c) => !isTextChild(c));
  if (el.openingElement.selfClosing) throw new VisualEditError(`<${elementName(el)}> has no text content`);
  if (others.some((c) => c.type === "JSXExpressionContainer" && c.expression.type !== "JSXEmptyExpression")) {
    throw new VisualEditError(`The text of <${elementName(el)}> is (partly) computed in code ({…}) — edit it in the code view or ask the AI`);
  }
  if (textChildren.length > 1) throw new VisualEditError(`<${elementName(el)}> mixes text with other elements — select the text itself`);
  const clean = text.replace(/\r\n?/g, "\n").replace(/\s*\n\s*/g, " ").trim();
  const node = /[{}<>]/.test(clean) || /^\s|\s$/.test(text) ? b.jsxExpressionContainer(b.stringLiteral(clean)) : b.jsxText(clean);
  if (textChildren.length === 1) {
    const idx = el.children.indexOf(textChildren[0]);
    el.children.splice(idx, 1, node);
  } else if (!others.length) {
    el.children = [node];
  } else {
    // element with icons only (e.g. <Button><Icon/></Button>) → text after them
    el.children.push(node);
  }
}

function applySetClass(el: any, op: Extract<VisualOp, { op: "setClass" }>) {
  const compute = (current: string) => (op.className !== undefined ? mergeClasses(op.className, op.add, op.remove) : mergeClasses(current, op.add, op.remove));
  const attr = getAttr(el, "className") ?? getAttr(el, "class");
  if (!attr) {
    const v = compute("");
    if (v) el.openingElement.attributes.push(b.jsxAttribute(b.jsxIdentifier("className"), b.stringLiteral(v)));
    return;
  }
  const val = attr.value;
  if (val?.type === "StringLiteral") {
    const v = compute(val.value);
    if (v) attr.value = b.stringLiteral(v);
    else removeAttr(el, attr.name.name);
    return;
  }
  if (val?.type === "JSXExpressionContainer") {
    const ex = val.expression;
    if (ex.type === "StringLiteral") {
      attr.value = b.stringLiteral(compute(ex.value));
      return;
    }
    if (ex.type === "TemplateLiteral" && ex.expressions.length === 0) {
      attr.value = b.stringLiteral(compute(ex.quasis.map((q: any) => q.value.cooked).join("")));
      return;
    }
    if (ex.type === "CallExpression" && ex.callee.type === "Identifier" && /^(cn|clsx|cx|twMerge|classNames)$/.test(ex.callee.name)) {
      const first = ex.arguments.find((a: any) => a.type === "StringLiteral");
      if (first) {
        const idx = ex.arguments.indexOf(first);
        ex.arguments[idx] = b.stringLiteral(compute(first.value));
      } else ex.arguments.unshift(b.stringLiteral(compute("")));
      return;
    }
  }
  throw new VisualEditError(`The classes of <${elementName(el)}> are computed in code — edit them in the code view or ask the AI`);
}

const CSS_PROP = /^-?[a-zA-Z][a-zA-Z0-9-]*$/;
const camel = (p: string) => (p.startsWith("--") ? p : p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));

function applySetStyle(el: any, style: Record<string, string | number | null>) {
  const attr = getAttr(el, "style");
  let obj: any;
  if (!attr) {
    obj = b.objectExpression([]);
    el.openingElement.attributes.push(b.jsxAttribute(b.jsxIdentifier("style"), b.jsxExpressionContainer(obj)));
  } else if (attr.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "ObjectExpression") obj = attr.value.expression;
  else throw new VisualEditError(`The style of <${elementName(el)}> is computed in code — edit it in the code view`);
  for (const [rawKey, value] of Object.entries(style)) {
    if (!CSS_PROP.test(rawKey) && !rawKey.startsWith("--")) throw new VisualEditError(`Invalid style property "${rawKey}"`, 400);
    const key = camel(rawKey);
    const idx = (obj.properties as any[]).findIndex((p) => (p.type === "ObjectProperty" || p.type === "Property") && ((p.key.type === "Identifier" && p.key.name === key) || (p.key.type === "StringLiteral" && p.key.value === key)));
    if (value === null || value === "") {
      if (idx >= 0) obj.properties.splice(idx, 1);
      continue;
    }
    if (typeof value === "string" && /[;{}<>]|url\(\s*['"]?\s*javascript:/i.test(value)) throw new VisualEditError(`Invalid value for ${rawKey}`, 400);
    const v = typeof value === "number" ? b.numericLiteral(value) : b.stringLiteral(String(value).slice(0, 500));
    const prop = b.objectProperty(/^[a-zA-Z_$][\w$]*$/.test(key) ? b.identifier(key) : b.stringLiteral(key), v);
    if (idx >= 0) obj.properties[idx] = prop;
    else obj.properties.push(prop);
  }
  if (!obj.properties.length) removeAttr(el, "style");
}

const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
const URL_ATTRS = new Set(["href", "src", "action", "formAction", "poster", "srcSet"]);

function applySetAttr(el: any, name: string, value: string | null) {
  if (!ATTR_NAME.test(name) || /^on/i.test(name) || name === "dangerouslySetInnerHTML" || name === "key" || name === "ref" || name === "data-lv-src" || name === "className" || name === "style") {
    throw new VisualEditError(`Attribute "${name}" can't be edited visually`, 400);
  }
  if (value === null) {
    removeAttr(el, name);
    return;
  }
  if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) throw new VisualEditError("Unsafe URL", 400);
  if (value.length > 4000) throw new VisualEditError("Value is too long", 400);
  setStringAttr(el, name, value);
}

/** Identifiers referenced by JSX names / expressions inside a subtree. */
function referencedNames(node: any): Set<string> {
  const s = new Set<string>();
  walk(node, (n) => {
    if (n.type === "JSXIdentifier" && /^[A-Z]/.test(n.name)) s.add(n.name);
    if (n.type === "Identifier") s.add(n.name);
  });
  return s;
}

/** Remove import specifiers in `candidates` that are no longer referenced anywhere in the file. */
function pruneImports(ast: any, candidates: Set<string>) {
  if (!candidates.size) return;
  const used = new Set<string>();
  walk(ast.program, (n, parent, key) => {
    if (n.type === "ImportDeclaration") return false;
    if (n.type === "JSXIdentifier") used.add(n.name);
    if (n.type === "Identifier") {
      // skip non-computed member property names / object keys
      if (parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed) return;
      if (parent && parent.type === "ObjectProperty" && key === "key" && !parent.computed) return;
      used.add(n.name);
    }
  });
  const body = ast.program.body as any[];
  for (let i = body.length - 1; i >= 0; i--) {
    const d = body[i];
    if (d.type !== "ImportDeclaration" || !d.specifiers?.length) continue;
    const before = d.specifiers.length;
    d.specifiers = d.specifiers.filter((sp: any) => !(candidates.has(sp.local.name) && !used.has(sp.local.name)));
    if (!d.specifiers.length && before) body.splice(i, 1);
  }
}

function ensureImport(ctx: FileCtx, name: string, from: string): string {
  const body = ctx.ast.program.body as any[];
  // already imported from the same module?
  for (const d of body) {
    if (d.type === "ImportDeclaration" && d.source.value === from) {
      const def = d.specifiers?.find((s: any) => s.type === "ImportDefaultSpecifier");
      if (def) return def.local.name;
    }
  }
  const taken = new Set<string>();
  walk(ctx.ast.program, (n) => {
    if (n.type === "Identifier" || n.type === "JSXIdentifier") taken.add(n.name);
  });
  let local = name;
  for (let i = 2; taken.has(local); i++) local = `${name}${i}`;
  const decl = b.importDeclaration([b.importDefaultSpecifier(b.identifier(local))], b.stringLiteral(from));
  let at = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body[i];
    if (d.type === "ImportDeclaration") at = i + 1;
    else if (i === at && d.type === "ExpressionStatement" && d.directive) at = i + 1; // "use client"
  }
  body.splice(at, 0, decl);
  return local;
}

/**
 * `<Button asChild><Link …/></Button>`: the DOM node (and its data-lv-src) belongs to the child, but structurally the
 * pair is one element (Radix Slot needs exactly one child). Structural ops (move/duplicate/delete/insert next to)
 * therefore target the asChild parent.
 */
export function structuralTarget(ast: any, el: any): any {
  let cur = el;
  for (let i = 0; i < 5; i++) {
    const c = jsxContainer(ast, cur);
    if (!c || c.parent.type !== "JSXElement") return cur;
    const asChild = getAttr(c.parent, "asChild");
    if (!asChild || (asChild.value && !(asChild.value.type === "JSXExpressionContainer" && asChild.value.expression.type === "BooleanLiteral" && asChild.value.expression.value))) return cur;
    const meaningful = (c.children as any[]).filter((x) => !(x.type === "JSXText" && !x.value.trim()));
    if (meaningful.length !== 1) return cur;
    cur = c.parent;
  }
  return cur;
}

function requireContainer(ctx: FileCtx, el: any, what: string) {
  const c = jsxContainer(ctx.ast, el);
  if (!c) throw new VisualEditError(`Can't ${what} <${elementName(el)}>: it is the root of a component or rendered by code — select an element inside it`);
  return c;
}

// ───────────────────────────── per-file application ─────────────────────────────

type ResolvedOp = { op: VisualOp; el: any; target?: any };

export type ApplyFileResult = { code: string; results: OpResult[]; newComponents: Array<{ id: string; file: string; source: string }> };

/**
 * Apply ops that all address `file` (whose current source is `code`). Pure (no I/O) except reading the component
 * library for inserts. Prettier formatting is applied by the caller via `format`.
 */
export async function applyToSource(
  file: string,
  code: string,
  ops: VisualOp[],
  opts: { format?: (code: string) => Promise<string>; componentFile?: (id: string) => { importPath: string; name: string } } = {},
): Promise<ApplyFileResult> {
  const ast = parseCode(code);
  const ctx: FileCtx = { ast, file, imports: [], prune: new Set(), marks: [] };
  const resolve = (src: string) => {
    const r = parseSrc(src);
    if (r.file !== file) throw new VisualEditError(`Element ${src} is in another file`, 400);
    const f = findElement(ast, r.line, r.col);
    if (!f) throw new VisualEditError(`Element ${src} was not found — the file changed. Reload the preview and try again.`, 409);
    return f.node;
  };
  // resolve every target by ORIGINAL positions before mutating
  const resolved: ResolvedOp[] = ops.map((op) => {
    if (op.op === "insert") return { op, el: op.position === "before" || op.position === "after" ? structuralTarget(ast, resolve(op.target)) : resolve(op.target) };
    if (op.op === "move") return { op, el: structuralTarget(ast, resolve(op.src)), target: structuralTarget(ast, resolve(op.target)) };
    if (op.op === "duplicate" || op.op === "delete") return { op, el: structuralTarget(ast, resolve(op.src)) };
    return { op, el: resolve(op.src) };
  });
  const results: OpResult[] = [];
  const newComponents: ApplyFileResult["newComponents"] = [];
  for (const { op, el, target } of resolved) {
    const name = elementName(el);
    switch (op.op) {
      case "setText": {
        const before = textOf(el);
        applySetText(el, op.text);
        results.push({ op: op.op, src: op.src, file, description: `text of <${name}>${before ? ` "${before.slice(0, 30)}"` : ""}` });
        break;
      }
      case "setClass":
        applySetClass(el, op);
        results.push({ op: op.op, src: op.src, file, description: `classes of <${name}>` });
        break;
      case "setStyle":
        applySetStyle(el, op.style);
        results.push({ op: op.op, src: op.src, file, description: `style of <${name}>` });
        break;
      case "setAttr":
        applySetAttr(el, op.name, op.value);
        results.push({ op: op.op, src: op.src, file, description: `${op.name} of <${name}>` });
        break;
      case "move": {
        if (el === target) throw new VisualEditError("An element can't be moved next to itself", 400);
        const c = requireContainer(ctx, el, "move");
        const t = jsxContainer(ast, target);
        if (!t || t.parent !== c.parent) throw new VisualEditError("Elements can only be reordered within the same parent", 400);
        c.children.splice(c.children.indexOf(el), 1);
        const ti = c.children.indexOf(target);
        c.children.splice(op.position === "before" ? ti : ti + 1, 0, el);
        const r: OpResult = { op: op.op, src: op.src, file, description: `moved <${name}> ${op.position} <${elementName(target)}>` };
        ctx.marks.push({ el, result: r });
        results.push(r);
        break;
      }
      case "duplicate": {
        const c = requireContainer(ctx, el, "duplicate");
        const copy = cloneNode(el);
        removeAttr(copy, "key");
        removeAttr(copy, "id");
        c.children.splice(c.children.indexOf(el) + 1, 0, b.jsxText("\n"), copy);
        const r: OpResult = { op: op.op, src: op.src, file, description: `duplicated <${name}>` };
        ctx.marks.push({ el: copy, result: r });
        results.push(r);
        break;
      }
      case "delete": {
        const c = requireContainer(ctx, el, "delete");
        for (const n of referencedNames(el)) ctx.prune.add(n);
        c.children.splice(c.children.indexOf(el), 1);
        results.push({ op: op.op, src: op.src, file, description: `deleted <${name}>` });
        break;
      }
      case "insert": {
        const target2 = opts.componentFile?.(op.component) ?? { importPath: `@/components/sections/${op.component}`, name: componentName(op.component) };
        const local = ensureImport(ctx, target2.name, target2.importPath);
        const node = b.jsxElement(b.jsxOpeningElement(b.jsxIdentifier(local), [], true), null, []);
        if (op.position === "before" || op.position === "after") {
          const c = requireContainer(ctx, el, "insert next to");
          const i = c.children.indexOf(el);
          c.children.splice(op.position === "before" ? i : i + 1, 0, ...(op.position === "before" ? [node, b.jsxText("\n")] : [b.jsxText("\n"), node]));
        } else {
          if (el.openingElement.selfClosing) {
            el.openingElement.selfClosing = false;
            el.closingElement = b.jsxClosingElement(cloneNode(el.openingElement.name));
            el.children = [];
          }
          if (op.position === "inside-start") el.children.unshift(b.jsxText("\n"), node);
          else el.children.push(b.jsxText("\n"), node, b.jsxText("\n"));
        }
        const r: OpResult = { op: op.op, src: op.target, file, description: `added ${componentName(op.component)} section` };
        ctx.marks.push({ el: node, result: r });
        results.push(r);
        newComponents.push({ id: op.component, file: target2.importPath, source: "" });
        break;
      }
    }
  }
  pruneImports(ast, ctx.prune);
  // marks → locate new positions after formatting
  for (const m of ctx.marks) mark(m.el);
  let out = recast.print(ast, { quote: "double" }).code;
  const format = opts.format ?? (async (c: string) => c);
  out = await format(out);
  if (ctx.marks.length) {
    const located = locateMarks(out);
    out = out.replace(new RegExp(`\\s*${MARK}="1"`, "g"), "");
    out = await format(out);
    // positions are stable (the marker sits after the tag name); verify against the final code
    const finalAst = parseCode(out);
    ctx.marks.forEach((m, i) => {
      const loc = located[i];
      if (!loc) return;
      const f = findElement(finalAst, loc.line, loc.col);
      m.result.newSrc = f ? formatSrc({ file, line: loc.line, col: loc.col }) : null;
    });
  }
  return { code: out, results, newComponents };
}

function locateMarks(code: string): Array<{ line: number; col: number }> {
  const ast = parseCode(code);
  const found: Array<{ line: number; col: number }> = [];
  walk(ast.program, (n) => {
    if (n.type === "JSXElement" && getAttr(n, MARK)) found.push({ line: n.loc.start.line, col: n.loc.start.column + 1 });
  });
  return found;
}

// ───────────────────────────── prettier ─────────────────────────────

/** Format with the project's prettier config (falls back to printWidth 160). Returns the input on prettier errors. */
export async function prettierFormat(code: string, absFile: string): Promise<string> {
  const prettier = await import("prettier");
  const cfg = (await prettier.resolveConfig(absFile).catch(() => null)) ?? { printWidth: 160 };
  try {
    return await prettier.format(code, { ...cfg, filepath: absFile, parser: absFile.endsWith(".tsx") || absFile.endsWith(".ts") ? "typescript" : "babel" });
  } catch {
    return code;
  }
}

// ───────────────────────────── workspace entry point ─────────────────────────────

export type VisualEditResult = { commit: string | null; message: string; files: string[]; results: OpResult[] };

function summarize(results: OpResult[]): string {
  if (results.length === 1) return `visual edit: ${results[0]!.description} in ${results[0]!.file}`;
  const kinds = [...new Set(results.map((r) => r.op))].join(", ");
  return `visual edit: ${results.length} changes (${kinds})\n\n${results.map((r) => `- ${r.description} (${r.file})`).join("\n")}`;
}

/**
 * Apply visual edit ops to a builder workspace and commit once. All ops of one request are resolved against the
 * current files (positions as rendered in the preview), applied, formatted and committed as "visual edit: …".
 */
export async function applyVisualEdits(builderId: string, rawOps: unknown[], opts: { author: CommitAuthor; message?: string }): Promise<VisualEditResult> {
  if (!Array.isArray(rawOps) || !rawOps.length) throw new VisualEditError("No edits", 400);
  if (rawOps.length > 50) throw new VisualEditError("Too many edits in one request (max 50)", 400);
  const ops = rawOps.map(normalizeOp);
  return withRepoLock(builderId, async () => {
    const root = repoDir(builderId);
    const byFile = new Map<string, VisualOp[]>();
    for (const op of ops) {
      const f = parseSrc(op.op === "insert" ? op.target : op.src).file;
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f)!.push(op);
    }
    const written: string[] = [];
    const results: OpResult[] = [];
    const pending: Array<{ abs: string; code: string }> = [];
    for (const [file, fileOps] of byFile) {
      const abs = path.join(root, file);
      const code = await fs.readFile(abs, "utf8").catch(() => {
        throw new VisualEditError(`${file} not found`, 404);
      });
      // library components needed by inserts → components/sections/<id>.tsx (copied once)
      const components = new Map<string, { importPath: string; name: string }>();
      for (const op of fileOps) {
        if (op.op !== "insert" || components.has(op.component)) continue;
        const { source } = (() => {
          try {
            return readLibraryComponent(op.component);
          } catch (e) {
            throw new VisualEditError((e as Error).message, 400);
          }
        })();
        const rel = `components/sections/${op.component}.tsx`;
        const absComp = path.join(root, rel);
        const exists = await fs.readFile(absComp, "utf8").catch(() => null);
        if (exists === null) pending.push({ abs: absComp, code: source });
        components.set(op.component, { importPath: `@/components/sections/${op.component}`, name: componentName(op.component) });
        if (exists === null) written.push(rel);
      }
      const r = await applyToSource(file, code, fileOps, {
        format: (c) => prettierFormat(c, abs),
        componentFile: (id) => components.get(id)!,
      });
      if (r.code !== code) {
        pending.push({ abs, code: r.code });
        written.push(file);
      }
      results.push(...r.results);
    }
    // write only after every file transformed successfully (all-or-nothing)
    for (const p of pending) {
      await fs.mkdir(path.dirname(p.abs), { recursive: true });
      await fs.writeFile(p.abs, p.code);
    }
    await fixOwnership(root).catch(() => {});
    const message = opts.message?.trim() ? `visual edit: ${opts.message.trim().replace(/^visual edit:\s*/i, "")}` : summarize(results);
    const sha = written.length ? await commitAll(builderId, message, opts.author, { paths: [...new Set(written)], lock: false }) : null;
    return { commit: sha, message, files: [...new Set(written)], results };
  });
}
