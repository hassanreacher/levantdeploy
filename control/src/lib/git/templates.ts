import fs from "node:fs";
import path from "node:path";
import { detectDir } from "./detect";

/**
 * Templates = the sample apps in the repository's `examples/` folder (build area).
 * Location: TEMPLATES_DIR env, else ../examples (repo checkout) or ./examples (container image).
 */
export type Template = { id: string; name: string; description: string | null; framework: string; frameworkName: string };

export function templatesDir(): string | null {
  const candidates = [process.env.TEMPLATES_DIR, path.resolve(process.cwd(), "../examples"), path.resolve(process.cwd(), "examples")].filter(Boolean) as string[];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isDirectory()) ?? null;
}

let cache: { at: number; items: Template[] } | null = null;

function describe(dir: string): string | null {
  for (const f of ["README.md", "readme.md"]) {
    try {
      const txt = fs.readFileSync(path.join(dir, f), "utf8");
      const line = txt
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#") && !l.startsWith("!["));
      if (line) return line.slice(0, 160);
    } catch {}
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { description?: string };
    if (pkg.description) return pkg.description.slice(0, 160);
  } catch {}
  return null;
}

export function listTemplates(): Template[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.items;
  const root = templatesDir();
  const items: Template[] = [];
  if (root) {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name.startsWith("_")) continue;
      const dir = path.join(root, d.name);
      const det = detectDir(dir);
      items.push({ id: d.name, name: d.name, description: describe(dir), framework: det.framework, frameworkName: det.frameworkName });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), items };
  return items;
}

export function templatePath(id: string): string | null {
  const root = templatesDir();
  if (!root || !/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) return null;
  const p = path.join(root, id);
  return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
}
