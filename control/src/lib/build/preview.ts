import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Project } from "@prisma/client";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { cloneRepo, displayUrl } from "@/lib/sources/git";
import { extractArchive, singleTopDir } from "@/lib/sources/archive";
import { getGitAuth } from "@/lib/sources/git-auth";
import { normalizeRootDirectory, storageRoot, workRoot } from "@/lib/sources";
import { detect } from "./detect";
import { generateDockerfile } from "./dockerfile";
import { parseBuildSettings, type BuildSettings, type Detection } from "./types";

/**
 * "What will happen if I deploy?" — detection on the latest source (git HEAD of the production branch or the latest
 * upload) or on a given archive, with optional unsaved settings. Used by POST /api/v1/projects/:id/detect.
 */
export type DetectPreview = {
  detection: Detection;
  /** generated Dockerfile (strategy "generated") */
  dockerfile: string | null;
  source: { kind: "git" | "upload" | "archive" | "image"; ref?: string | null; commitSha?: string | null; label: string };
  /** top-level directories that look like apps (monorepo root directory suggestions) */
  rootDirectories: string[];
};

const APP_MARKERS = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle", "Dockerfile", "mix.exs", "deno.json", "index.html"];

export function suggestRootDirectories(repoDir: string): string[] {
  const out: string[] = [];
  const scan = (rel: string, depth: number) => {
    if (depth > 2 || out.length > 20) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(repoDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || ["node_modules", "dist", "build", "vendor", "target", "public", "src", "test", "tests", "docs"].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (APP_MARKERS.some((m) => fs.existsSync(path.join(repoDir, r, m)))) out.push(r);
      else scan(r, depth + 1);
    }
  };
  scan("", 0);
  return out;
}

export async function detectPreview(
  project: Project,
  opts: { archivePath?: string; settings?: BuildSettings; rootDirectory?: string; signal?: AbortSignal } = {},
): Promise<DetectPreview> {
  const settings = opts.settings ?? parseBuildSettings(project.buildSettings);
  const root = normalizeRootDirectory(opts.rootDirectory ?? project.rootDirectory);
  if (project.sourceType === "IMAGE" && !opts.archivePath) {
    const detection = detect(workRoot(), settings, { image: project.image ?? "?" });
    return { detection, dockerfile: null, source: { kind: "image", label: project.image ?? "no image" }, rootDirectories: [] };
  }
  const tmp = path.join(workRoot(), `detect-${crypto.randomBytes(6).toString("hex")}`);
  await fsp.mkdir(tmp, { recursive: true });
  try {
    let repoDir = path.join(tmp, "src");
    let source: DetectPreview["source"];
    if (opts.archivePath) {
      await extractArchive(opts.archivePath, repoDir, { maxBytes: 512 * 1024 ** 2 });
      repoDir = (await singleTopDir(repoDir)) && !(root && fs.existsSync(path.join(repoDir, root))) ? (await singleTopDir(repoDir))! : repoDir;
      source = { kind: "archive", label: "uploaded archive" };
    } else if (project.sourceType === "UPLOAD" || (!project.gitUrl && !project.githubRepoFullName)) {
      const up = await db.upload.findFirst({ where: { projectId: project.id, status: "COMPLETE" }, orderBy: { createdAt: "desc" } });
      if (!up) throw new Error("No uploaded source yet — deploy once with the CLI or upload a folder");
      const file = path.resolve(storageRoot(), up.path);
      if (!fs.existsSync(file)) throw new Error("The latest upload is no longer on disk");
      await extractArchive(file, repoDir, { maxBytes: 2 * 1024 ** 3 });
      const top = await singleTopDir(repoDir);
      if (top && !(root && fs.existsSync(path.join(repoDir, root)))) repoDir = top;
      source = { kind: "upload", label: `upload of ${up.createdAt.toISOString().slice(0, 16).replace("T", " ")}` };
    } else {
      const auth = await getGitAuth(project);
      const url = auth?.url ?? project.gitUrl ?? `https://github.com/${project.githubRepoFullName}.git`;
      const r = await cloneRepo({ url, dest: repoDir, branch: project.productionBranch, auth: auth?.auth, signal: opts.signal, timeoutMs: 120_000, submodules: false });
      source = { kind: "git", ref: project.productionBranch, commitSha: r.commitSha, label: `${displayUrl(url)}@${project.productionBranch} (${r.commitSha.slice(0, 7)})` };
    }
    const contextDir = path.join(repoDir, root);
    if (!fs.existsSync(contextDir)) throw new Error(`Root directory "${root}" does not exist`);
    const detection = detect(contextDir, settings, { repoDir });
    let dockerfile: string | null = null;
    if (detection.strategy === "generated" && detection.framework !== "unknown") {
      try {
        dockerfile = generateDockerfile({ detection, settings, cacheKey: project.id, registryMirror: await getSetting("build.registryMirror") }).dockerfile;
      } catch {
        dockerfile = null;
      }
    } else if (detection.strategy === "dockerfile" && detection.meta.inline) {
      dockerfile = settings.dockerfileInline ?? null;
    } else if (detection.strategy === "dockerfile") {
      dockerfile = await fsp.readFile(path.resolve(contextDir, detection.dockerfilePath ?? "Dockerfile"), "utf8").catch(() => null);
    }
    return { detection, dockerfile, source, rootDirectories: suggestRootDirectories(repoDir) };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
