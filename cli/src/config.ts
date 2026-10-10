import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ~/.levant/config.json (0600) + per-folder link file .levant/project.json */
export type GlobalConfig = { server?: string; token?: string; user?: { email: string; name: string } | null; team?: string | null };
export type ProjectLink = { server: string; projectId: string; projectSlug: string; teamSlug: string };

export const configDir = () => process.env.LEVANT_CONFIG_DIR || path.join(os.homedir(), ".levant");
export const configFile = () => path.join(configDir(), "config.json");

export function readConfig(): GlobalConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8")) as GlobalConfig;
  } catch {
    return {};
  }
}

export function writeConfig(c: GlobalConfig) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(configFile(), 0o600);
  } catch {}
}

export const linkFile = (dir: string) => path.join(dir, ".levant", "project.json");

export function readLink(dir: string): ProjectLink | null {
  try {
    return JSON.parse(fs.readFileSync(linkFile(dir), "utf8")) as ProjectLink;
  } catch {
    return null;
  }
}

export function writeLink(dir: string, link: ProjectLink) {
  fs.mkdirSync(path.dirname(linkFile(dir)), { recursive: true });
  fs.writeFileSync(linkFile(dir), JSON.stringify(link, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, ".levant", "README.txt"), "This folder is created by `levant link`. It links the directory to a LevantDeploy project. Do not commit it.\n");
  // keep .levant out of git
  const gi = path.join(dir, ".gitignore");
  try {
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : null;
    if (cur !== null && !/^\.levant\/?$/m.test(cur)) fs.appendFileSync(gi, `${cur.endsWith("\n") || !cur ? "" : "\n"}.levant\n`);
  } catch {}
}

export function normalizeServer(s: string): string {
  let v = s.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(v)) v = (/^(localhost|127\.|\[::1\])/.test(v) ? "http://" : "https://") + v;
  return v;
}
