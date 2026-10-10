import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";
import * as tar from "tar";

/**
 * Collects the files to deploy: respects .gitignore (root + nested) and .levantignore, and always skips
 * VCS folders, dependencies, build caches and local env files.
 */
export const ALWAYS_IGNORE = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".levant",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.local",
  ".env.*.local",
  "*.pem",
  "npm-debug.log*",
  "yarn-error.log*",
];

// `ignore` is CommonJS (module.exports = factory): load it with require for NodeNext + ESM output
const ignore = createRequire(import.meta.url)("ignore") as () => Ignore;

type Layer = { base: string; ig: Ignore };

export function listFiles(root: string, opts: { maxFiles?: number } = {}): string[] {
  const max = opts.maxFiles ?? 100_000;
  const out: string[] = [];
  const always = ignore().add(ALWAYS_IGNORE);
  const rootIg = ignore();
  for (const f of [".gitignore", ".levantignore"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) rootIg.add(fs.readFileSync(p, "utf8"));
  }
  const walk = (rel: string, layers: Layer[]) => {
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    let local = layers;
    if (rel) {
      const gi = path.join(abs, ".gitignore");
      if (fs.existsSync(gi)) local = [...layers, { base: rel, ig: ignore().add(fs.readFileSync(gi, "utf8")) }];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      const test = isDir ? `${r}/` : r;
      if (always.ignores(test) || always.ignores(e.name + (isDir ? "/" : ""))) continue;
      if (rootIg.ignores(test)) continue;
      if (local.some((l) => l.base && l.ig.ignores(path.posix.relative(l.base, test) + (isDir ? "/" : "")))) continue;
      if (isDir) walk(r, local);
      else if (e.isFile() || e.isSymbolicLink()) {
        out.push(r);
        if (out.length > max) throw new Error(`More than ${max} files — add a .levantignore`);
      }
    }
  };
  walk("", [{ base: "", ig: rootIg }]);
  return out;
}

export async function packDirectory(root: string): Promise<{ file: string; size: number; sha256: string; files: string[] }> {
  const files = listFiles(root);
  if (!files.length) throw new Error("Nothing to deploy: the folder is empty (or everything is ignored)");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "levant-")), "source.tar.gz");
  await tar.c({ gzip: { level: 6 }, file, cwd: root, portable: true, noMtime: false, follow: false }, files);
  const buf = fs.readFileSync(file);
  return { file, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), files };
}
