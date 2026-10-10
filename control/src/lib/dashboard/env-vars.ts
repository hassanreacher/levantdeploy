import type { EnvTarget } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptString } from "@/lib/crypto";

/**
 * Environment variables (dashboard area). Worker-safe (no next/* imports).
 *
 *   parseDotenv("A=1\nexport B='two'\n# c")      → [{ key: "A", value: "1" }, { key: "B", value: "two" }]
 *   await resolveEnv(projectId, "PREVIEW", "feat/x") → { A: "1", … }   (shared groups < project < branch override)
 */

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_TARGETS: EnvTarget[] = ["PRODUCTION", "PREVIEW", "DEVELOPMENT"];
/** Injected by the platform at runtime; users can't override them. */
export const RESERVED_ENV_KEYS = new Set(["LEVANT", "LEVANT_ENV", "LEVANT_URL", "LEVANT_DEPLOYMENT_ID", "LEVANT_GIT_COMMIT_SHA", "LEVANT_GIT_BRANCH"]);
export const MAX_ENV_VALUE = 64 * 1024;

export function envKeyError(key: string): string | null {
  if (!key) return "Key is required";
  if (key.length > 256) return "Key is too long";
  if (!ENV_KEY_RE.test(key)) return "Use letters, digits and underscores; don't start with a digit";
  if (RESERVED_ENV_KEYS.has(key.toUpperCase())) return `${key} is reserved by LevantDeploy`;
  return null;
}

/** Parses a .env file. Supports `export`, comments, single/double quotes, `\n` escapes and multi-line double-quoted values. */
export function parseDotenv(text: string): { key: string; value: string; line: number }[] {
  const out: { key: string; value: string; line: number }[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let rest = m[2] ?? "";
    let value: string;
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      // find the closing quote (possibly on a later line for double quotes / backticks)
      let body = rest.slice(1);
      let end = findClose(body, q);
      const startLine = i;
      while (end < 0 && q !== "'" && i + 1 < lines.length) {
        i++;
        body += "\n" + lines[i]!;
        end = findClose(body, q);
      }
      if (end < 0) {
        i = startLine; // unterminated: treat the rest of the line literally
        value = rest;
      } else {
        value = body.slice(0, end);
        if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      value = rest.trim();
    }
    out.push({ key, value, line: i + 1 });
  }
  // last one wins (like dotenv)
  const seen = new Map<string, { key: string; value: string; line: number }>();
  for (const e of out) seen.set(e.key, e);
  return [...seen.values()];
}

function findClose(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && q === '"') {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/** Serialises vars to a .env file (values double-quoted when needed). */
export function toDotenv(vars: { key: string; value: string }[]): string {
  return (
    vars
      .map(({ key, value }) => {
        const needsQuote = /[\s#"'`\\$]/.test(value) || value === "";
        return `${key}=${needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"` : value}`;
      })
      .join("\n") + "\n"
  );
}

/**
 * Effective env for a deployment: linked shared env groups (alphabetical) < project vars < branch-specific
 * project vars (PREVIEW only). Values the server can't decrypt are skipped.
 * The build + runtime areas call this to inject env vars.
 */
export async function resolveEnv(projectId: string, target: EnvTarget, branch?: string | null): Promise<Record<string, string>> {
  const [links, own] = await Promise.all([
    db.projectSharedEnvGroup.findMany({
      where: { projectId },
      include: { group: { include: { vars: { where: { targets: { has: target } } } } } },
      orderBy: { group: { name: "asc" } },
    }),
    db.envVar.findMany({ where: { projectId, targets: { has: target } }, orderBy: { createdAt: "asc" } }),
  ]);
  const env: Record<string, string> = {};
  for (const l of links)
    for (const v of l.group.vars) {
      const val = decryptString(v.valueEnc);
      if (val !== null) env[v.key] = val;
    }
  for (const v of own.filter((x) => !x.branch)) {
    const val = decryptString(v.valueEnc);
    if (val !== null) env[v.key] = val;
  }
  if (target === "PREVIEW" && branch) {
    for (const v of own.filter((x) => x.branch === branch)) {
      const val = decryptString(v.valueEnc);
      if (val !== null) env[v.key] = val;
    }
  }
  return env;
}
