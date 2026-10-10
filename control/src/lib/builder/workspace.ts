import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TEMPLATE, templateDir, templateFiles } from "./template";

/**
 * Builder workspaces (builder-core): STORAGE_DIR/builder/{id}/
 *   repo/        the app's git work tree (bind-mounted into the preview container at /app)
 *   ca.pem       optional proxy CA mounted into the preview (pnpm add through a TLS-intercepting proxy)
 * The repo is owned by the preview uid (BUILDER_PREVIEW_UID, default 1000 = `node` in the runtime image) so `next dev`
 * can write .next and `pnpm add` can update package.json; control runs git with safe.directory=*.
 * Worker-safe.
 */

const storageDir = () => path.resolve(process.env.STORAGE_DIR || "./storage");
export const builderRoot = () => path.join(storageDir(), "builder");
export const workspaceDir = (builderId: string) => {
  if (!/^[a-z0-9]{8,40}$/.test(builderId)) throw new Error("Invalid builder project id");
  return path.join(builderRoot(), builderId);
};
export const repoDir = (builderId: string) => path.join(workspaceDir(builderId), "repo");

/** Path of the repo as seen by the Docker daemon (control in a container: BUILDER_HOST_STORAGE_DIR = host path of STORAGE_DIR). */
export function hostRepoDir(builderId: string): string {
  const host = process.env.BUILDER_HOST_STORAGE_DIR;
  if (!host) return repoDir(builderId);
  return path.join(path.resolve(host), "builder", builderId, "repo");
}
export function hostWorkspaceDir(builderId: string): string {
  const host = process.env.BUILDER_HOST_STORAGE_DIR;
  if (!host) return workspaceDir(builderId);
  return path.join(path.resolve(host), "builder", builderId);
}

export const previewUid = () => Number(process.env.BUILDER_PREVIEW_UID || 1000);
export const previewGid = () => Number(process.env.BUILDER_PREVIEW_GID || process.env.BUILDER_PREVIEW_UID || 1000);

/** chown -R to the preview uid when we run as root (no-op otherwise / on failure). */
export async function fixOwnership(dir: string, opts: { recursive?: boolean } = { recursive: true }) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const uid = previewUid();
  const gid = previewGid();
  const walk = async (p: string) => {
    let st;
    try {
      st = await fs.lstat(p);
    } catch {
      return;
    }
    if (st.uid !== uid || st.gid !== gid) await fs.lchown(p, uid, gid).catch(() => {});
    if (st.isDirectory() && opts.recursive !== false) {
      for (const name of await fs.readdir(p)) {
        if (name === "node_modules" || name === ".next") continue;
        await walk(path.join(p, name));
      }
    }
  };
  await walk(dir);
}

export async function workspaceExists(builderId: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoDir(builderId), ".git"));
    return true;
  } catch {
    return false;
  }
}

function packageName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

/**
 * Create the workspace from a template: copy files, set package.json name, git init + initial commit.
 * Idempotent: an existing repo is left as is (returns its HEAD).
 */
export async function createWorkspace(builderId: string, opts: { template?: string; name?: string } = {}): Promise<{ dir: string; sha: string }> {
  const { initRepo, commitAll, headSha } = await import("./git");
  const dir = repoDir(builderId);
  if (await workspaceExists(builderId)) {
    const sha = await headSha(builderId);
    if (sha) return { dir, sha };
  }
  const tpl = opts.template ?? DEFAULT_TEMPLATE;
  const src = templateDir(tpl);
  await fs.mkdir(dir, { recursive: true });
  for (const rel of templateFiles(tpl)) {
    const to = path.join(dir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(path.join(src, rel), to);
  }
  const pkgFile = path.join(dir, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8")) as Record<string, unknown>;
  pkg.name = packageName(opts.name ?? "app");
  await fs.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  await initRepo(dir);
  const sha = await commitAll(builderId, `Create app from the ${tpl} template`, "system");
  await fixOwnership(workspaceDir(builderId));
  if (!sha) throw new Error("Template is empty");
  return { dir, sha };
}

/** Remove the whole workspace (repo, CA, caches). */
export async function deleteWorkspace(builderId: string) {
  await fs.rm(workspaceDir(builderId), { recursive: true, force: true });
}

// ───────────────────────────── preview-only env (.env.local, never committed) ─────────────────────────────

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envLine(k: string, v: string) {
  // dotenv: double quotes with escaped newlines/quotes
  return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Write `.env.local` in the repo (gitignored → never committed / published). Replaces the managed block. */
export async function writeEnvLocal(builderId: string, vars: Record<string, string>) {
  const file = path.join(repoDir(builderId), ".env.local");
  const lines = ["# Managed by LevantDeploy Builder (preview only — never committed). Backend: LevantBase.", ...Object.entries(vars).filter(([k]) => ENV_KEY.test(k)).map(([k, v]) => envLine(k, v))];
  await fs.writeFile(file, lines.join("\n") + "\n", { mode: 0o640 });
  await fixOwnership(file, { recursive: false });
}

export async function readEnvLocalKeys(builderId: string): Promise<string[]> {
  try {
    const txt = await fs.readFile(path.join(repoDir(builderId), ".env.local"), "utf8");
    return txt
      .split("\n")
      .map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

export async function removeEnvLocal(builderId: string) {
  await fs.rm(path.join(repoDir(builderId), ".env.local"), { force: true });
}
