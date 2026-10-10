import fs from "node:fs";
import path from "node:path";
import { detect } from "@/lib/build/detect";
import type { Detection } from "@/lib/build/types";
import type { GitAuth } from "@/lib/sources/types";
import { shallowClone } from "./exec";

/**
 * Framework detection before import (adapter over the build area's detector).
 * Falls back to { framework: "auto" } when detection fails — the build re-detects anyway.
 */
export type DetectResult = Pick<Detection, "framework" | "frameworkName" | "kind" | "port" | "installCommand" | "buildCommand" | "startCommand" | "outputDirectory" | "notes" | "strategy"> & {
  rootDirectories?: string[];
};

const AUTO: DetectResult = { framework: "auto", frameworkName: "Auto-detect at build time", kind: "WEB", port: 3000, notes: [], strategy: "generated" };

export function safeRoot(rootDirectory: string): string {
  const clean = rootDirectory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean.split("/").includes("..")) throw new Error("Invalid root directory");
  return clean;
}

export function detectDir(repoDir: string, rootDirectory = ""): DetectResult {
  try {
    const dir = path.join(repoDir, safeRoot(rootDirectory));
    if (!fs.existsSync(dir)) return { ...AUTO, notes: [`Root directory "${rootDirectory}" not found`] };
    const d = detect(dir, {}, { repoDir });
    return {
      framework: d.framework,
      frameworkName: d.frameworkName,
      kind: d.kind,
      port: d.port,
      installCommand: d.installCommand ?? null,
      buildCommand: d.buildCommand ?? null,
      startCommand: d.startCommand ?? null,
      outputDirectory: d.outputDirectory ?? null,
      notes: d.notes,
      strategy: d.strategy,
      rootDirectories: candidateRoots(repoDir),
    };
  } catch (e) {
    return { ...AUTO, notes: [(e as Error).message] };
  }
}

/** Sub-folders that look like apps (monorepos: apps/*, packages/*, top-level folders with a manifest). */
export function candidateRoots(repoDir: string): string[] {
  const manifests = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "Dockerfile", "pom.xml", "index.html", "mix.exs", "deno.json"];
  const out: string[] = [];
  const check = (rel: string) => {
    if (manifests.some((m) => fs.existsSync(path.join(repoDir, rel, m)))) out.push(rel);
  };
  const ls = (rel: string) => {
    try {
      return fs
        .readdirSync(path.join(repoDir, rel), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => (rel ? `${rel}/${d.name}` : d.name));
    } catch {
      return [];
    }
  };
  for (const top of ls("")) {
    check(top);
    if (/^(apps|packages|services|examples|sites)$/.test(path.basename(top))) for (const sub of ls(top)) check(sub);
  }
  return out.slice(0, 50);
}

/** Shallow-clones the repo (30–90 s timeout) and detects. */
export async function detectRemote(url: string, branch: string | null, auth: GitAuth | null, rootDirectory = ""): Promise<DetectResult> {
  let dir: string | null = null;
  try {
    dir = await shallowClone(url, branch, auth);
    return detectDir(dir, rootDirectory);
  } catch (e) {
    return { ...AUTO, notes: [`Could not inspect the repository: ${(e as Error).message}`] };
  } finally {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
