import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Deployment, Project, Upload } from "@prisma/client";
import { db } from "@/lib/db";
import { cloneRepo, displayUrl, resolveRemoteRef } from "./git";
import { extractArchive, singleTopDir } from "./archive";
import { getGitAuth } from "./git-auth";
import type { FetchedSource, SourceLogger } from "./types";

export * from "./types";
export { registerGitAuthProvider, getGitAuth } from "./git-auth";
export { extractArchive, safeRelPath, ArchiveError } from "./archive";
export { cloneRepo, displayUrl, resolveRemoteRef } from "./git";

/** STORAGE_DIR/work (or WORK_DIR) */
export function workRoot(): string {
  if (process.env.WORK_DIR) return path.resolve(process.env.WORK_DIR);
  return path.resolve(process.env.STORAGE_DIR || "./storage", "work");
}
export const storageRoot = () => path.resolve(process.env.STORAGE_DIR || "./storage");
export const workDirFor = (deploymentId: string) => path.join(workRoot(), deploymentId.replace(/[^a-zA-Z0-9_-]/g, ""));

/** Validate + normalize Project.rootDirectory ("apps/web/" → "apps/web"). Throws on traversal. */
export function normalizeRootDirectory(root: string | null | undefined): string {
  const clean = (root ?? "").replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "").replace(/^\.$/, "");
  if (clean.split("/").some((p) => p === "..")) throw new Error(`Invalid root directory "${root}"`);
  return clean;
}

export type FetchOptions = {
  log: SourceLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type Dep = Pick<Deployment, "id" | "branch" | "commitSha" | "uploadId" | "sourceDeploymentId">;
type Proj = Pick<
  Project,
  "id" | "teamId" | "sourceType" | "gitUrl" | "githubInstallationId" | "githubRepoFullName" | "gitDeployKeyEnc" | "gitDeployKeyPublic" | "productionBranch" | "rootDirectory" | "image"
>;

/**
 * Fetch the source of a deployment into WORK_DIR/{deploymentId}/src:
 *  GITHUB / GIT → shallow clone at branch/sha · UPLOAD → safe extraction of the Upload tarball · IMAGE → nothing.
 */
export async function fetchSource(dep: Dep, project: Proj, opts: FetchOptions): Promise<FetchedSource> {
  const base = workDirFor(dep.id);
  const repoDir = path.join(base, "src");
  await fsp.rm(base, { recursive: true, force: true });
  await fsp.mkdir(base, { recursive: true });
  const root = normalizeRootDirectory(project.rootDirectory);

  if (project.sourceType === "IMAGE") {
    if (!project.image) throw new Error("Project has no image configured");
    return { repoDir, contextDir: repoDir, kind: "image", image: project.image };
  }

  // an uploaded tarball wins (CLI deploys of git-connected projects upload too)
  const uploadId = dep.uploadId ?? (dep.sourceDeploymentId ? (await db.deployment.findUnique({ where: { id: dep.sourceDeploymentId }, select: { uploadId: true } }))?.uploadId : null);
  if (uploadId || project.sourceType === "UPLOAD") {
    if (!uploadId) throw new Error("This deployment has no uploaded source (deploy with the CLI or upload a folder)");
    const upload = await db.upload.findUnique({ where: { id: uploadId } });
    if (!upload) throw new Error("Upload not found (it may have expired)");
    return extractUpload(upload, repoDir, root, opts);
  }

  const auth = await getGitAuth(project);
  const url = auth?.url ?? project.gitUrl ?? (project.githubRepoFullName ? `https://github.com/${project.githubRepoFullName}.git` : null);
  if (!url) throw new Error("Project has no Git repository configured");
  const branch = dep.branch || project.productionBranch || null;
  let commitSha = dep.commitSha;
  if (!commitSha && branch) {
    // "Deploy" button / API without a commit: pin the branch head first so the build is reproducible
    try {
      commitSha = await resolveRemoteRef(url, branch, auth?.auth ?? null, { signal: opts.signal });
      if (commitSha) await opts.log(`Resolved ${branch} → ${commitSha.slice(0, 7)}`);
      else throw new Error(`Branch "${branch}" not found in ${displayUrl(url)}`);
    } catch (e) {
      if ((e as Error).message.startsWith("Branch")) throw e;
      await opts.log(`Could not resolve ${branch} with ls-remote (${(e as Error).message.slice(0, 120)}) — cloning the branch head`);
    }
  }
  await opts.log(`Cloning ${displayUrl(url)} (branch ${branch ?? "default"}${commitSha ? `, commit ${commitSha.slice(0, 7)}` : ""})…`);
  const t = Date.now();
  const r = await cloneRepo({
    url,
    dest: repoDir,
    branch,
    commitSha,
    auth: auth?.auth ?? null,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    log: (l) => void opts.log(l),
  });
  await opts.log(`Cloned ${r.commitSha.slice(0, 7)} "${r.commitMessage.slice(0, 80)}" by ${r.commitAuthor} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const contextDir = path.join(repoDir, root);
  if (!fs.existsSync(contextDir)) throw new Error(`Root directory "${root}" does not exist in the repository`);
  return { repoDir, contextDir, kind: "git", commitSha: r.commitSha, commitMessage: r.commitMessage, commitAuthor: r.commitAuthor };
}

export async function extractUpload(upload: Pick<Upload, "id" | "path" | "size" | "status">, repoDir: string, root: string, opts: FetchOptions): Promise<FetchedSource> {
  if (upload.status !== "COMPLETE") throw new Error(`Upload is ${upload.status.toLowerCase()}, not complete`);
  const file = path.resolve(storageRoot(), upload.path);
  if (!file.startsWith(storageRoot() + path.sep)) throw new Error("Invalid upload path");
  if (!fs.existsSync(file)) throw new Error("Uploaded file is missing on disk (expired?)");
  await opts.log(`Extracting uploaded source (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)…`);
  const r = await extractArchive(file, repoDir);
  for (const s of r.skipped.slice(0, 20)) await opts.log(`  skipped ${s}`);
  // hoist a single top-level folder (zipballs) unless the root directory points inside it
  const top = await singleTopDir(repoDir);
  let dir = repoDir;
  if (top && !(root && fs.existsSync(path.join(repoDir, root)))) {
    dir = top;
    await opts.log(`Using the archive's top-level folder ${path.basename(top)}/`);
  }
  await opts.log(`Extracted ${r.files} files (${(r.bytes / 1024 / 1024).toFixed(1)} MB, ${r.format})`);
  const contextDir = path.join(dir, root);
  if (!fs.existsSync(contextDir)) throw new Error(`Root directory "${root}" does not exist in the upload`);
  return { repoDir: dir, contextDir, kind: "upload", bytes: r.bytes };
}

/** Delete a deployment's work dir. */
export async function cleanupWorkDir(deploymentId: string) {
  await fsp.rm(workDirFor(deploymentId), { recursive: true, force: true }).catch(() => {});
}

/** Remove work dirs older than maxAgeMs (crashed builds). */
export async function gcWorkDirs(maxAgeMs = 6 * 3600_000, keep: Set<string> = new Set()) {
  const rootDir = workRoot();
  const entries = await fsp.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || keep.has(e.name)) continue;
    const st = await fsp.stat(path.join(rootDir, e.name)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > maxAgeMs) {
      await fsp.rm(path.join(rootDir, e.name), { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}
