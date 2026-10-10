import { z } from "zod";
import { route, json, body, E } from "@/lib/http";
import { resolveTeam } from "@/lib/git/team";
import { parseGitUrl, defaultTokenUsername, repoNameFromUrl } from "@/lib/git/url";
import { lsRemote } from "@/lib/git/exec";
import { detectRemote } from "@/lib/git/detect";
import { readPendingKey } from "@/lib/git/pending-keys";
import type { GitAuth } from "@/lib/sources/types";

export const dynamic = "force-dynamic";

const schema = z.object({
  team: z.string().max(60).optional(),
  url: z.string().trim().min(3).max(1000),
  token: z.string().max(2000).nullable().optional(),
  tokenUsername: z.string().max(200).nullable().optional(),
  deployKeyId: z.string().nullable().optional(),
  branch: z.string().max(250).optional(),
  rootDirectory: z.string().max(500).default(""),
  detect: z.boolean().default(true),
});

/**
 * POST /api/v1/git/inspect — check access to a Git URL (any host) before import.
 * → { ok, name, defaultBranch, branches[], detection? } or 422 with the git error.
 */
export const POST = route(
  async (req) => {
    const input = await body(req, schema);
    const { team } = await resolveTeam(input.team, "MEMBER", { scope: "projects:write" });
    const parsed = parseGitUrl(input.url);
    if (!parsed) throw E.validation({ url: "Use https://host/owner/repo.git or git@host:owner/repo.git" }, "Invalid Git URL");
    if (parsed.protocol === "file" && process.env.GIT_ALLOW_FILE_URLS !== "1") throw E.validation({ url: "file:// URLs are not allowed" });
    let auth: GitAuth = { kind: "none" };
    if (parsed.isSsh) {
      const k = input.deployKeyId ? await readPendingKey(input.deployKeyId, team.id) : null;
      if (!k) throw E.validation({ url: "SSH URLs need a deploy key: generate one and add it to the repository" }, "Deploy key required");
      auth = { kind: "ssh", privateKey: k.privateKey };
    } else if (input.token) {
      auth = { kind: "token", token: input.token, username: input.tokenUsername || defaultTokenUsername(parsed.host) };
    }
    const url = parsed.isSsh ? input.url.trim() : parsed.clean;
    let remote;
    try {
      remote = await lsRemote(url, auth);
    } catch (e) {
      throw E.validation({ url: "Repository not reachable" }, `Could not access the repository: ${(e as Error).message}`);
    }
    const branches = Object.keys(remote.heads).sort((a, b) => (a === remote.defaultBranch ? -1 : b === remote.defaultBranch ? 1 : a.localeCompare(b)));
    const branch = input.branch || remote.defaultBranch || branches[0] || null;
    const detection = input.detect && branches.length ? await detectRemote(url, branch, auth, input.rootDirectory) : null;
    return json({ ok: true, url, name: repoNameFromUrl(url), defaultBranch: remote.defaultBranch, branches: branches.slice(0, 200), detection });
  },
  { limit: { limit: 30, window: 60 }, key: "git-inspect" },
);
