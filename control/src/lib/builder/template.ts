import fs from "node:fs";
import path from "node:path";

/**
 * Builder templates + component library (builder-core).
 *   builder-template/<template>/   the app copied into a new workspace (next15)
 *   builder-template/library/      section components for insertComponent (index.json = catalog)
 * Location: BUILDER_TEMPLATE_DIR, else the first existing of <cwd>/../builder-template, <cwd>/builder-template,
 * /app/builder-template (control image).
 * Worker-safe (no next/* imports).
 */

export const DEFAULT_TEMPLATE = "next15";
export const TEMPLATES = [
  {
    id: "next15",
    name: "Next.js 15 + shadcn/ui",
    description: "Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui, lucide icons and a Supabase-compatible backend client.",
  },
] as const;
export type TemplateId = (typeof TEMPLATES)[number]["id"];

/** Docker image of the live preview runtime (template deps pre-installed). */
export const runtimeImage = () => process.env.BUILDER_RUNTIME_IMAGE || "levant/builder-runtime:next15";

let cachedRoot: string | null = null;

export function templateRoot(): string {
  if (process.env.BUILDER_TEMPLATE_DIR) return path.resolve(process.env.BUILDER_TEMPLATE_DIR);
  if (cachedRoot) return cachedRoot;
  const candidates = [path.resolve(process.cwd(), "../builder-template"), path.resolve(process.cwd(), "builder-template"), "/app/builder-template"];
  cachedRoot = candidates.find((c) => fs.existsSync(path.join(c, DEFAULT_TEMPLATE, "package.json"))) ?? candidates[0]!;
  return cachedRoot;
}

export function isTemplate(id: string): id is TemplateId {
  return TEMPLATES.some((t) => t.id === id);
}

export function templateDir(id: string = DEFAULT_TEMPLATE): string {
  if (!isTemplate(id)) throw new Error(`Unknown template "${id}"`);
  return path.join(templateRoot(), id);
}

export const libraryDir = () => path.join(templateRoot(), "library");

export type LibraryComponent = { id: string; name: string; category: string; description: string; backend?: boolean };

export function listLibrary(): LibraryComponent[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(libraryDir(), "index.json"), "utf8")) as LibraryComponent[];
  } catch {
    return [];
  }
}

/** Source of a library component (validated id). */
export function readLibraryComponent(id: string): { meta: LibraryComponent; source: string } {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) throw new Error(`Unknown component "${id}"`);
  const meta = listLibrary().find((c) => c.id === id);
  if (!meta) throw new Error(`Unknown component "${id}"`);
  return { meta, source: fs.readFileSync(path.join(libraryDir(), `${id}.tsx`), "utf8") };
}

/** "contact-form" → "ContactForm" */
export function componentName(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}

const SKIP = new Set(["node_modules", ".next", ".git", ".levant", "out"]);

/** Every file of a template (relative paths, posix separators). */
export function templateFiles(id: string = DEFAULT_TEMPLATE): string[] {
  const root = templateDir(id);
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}
