import crypto from "node:crypto";

/**
 * Pure webhook logic (no DB / network) — unit tested in routing.test.ts.
 *  - verifySignature(): X-Hub-Signature-256 HMAC check (constant time)
 *  - routeGitHubEvent(): decides which deployments / cleanups an event causes for the projects linked to the repo
 */

export function signPayload(secret: string, body: string | Buffer): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, body: string | Buffer, header: string | null | undefined): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(signPayload(secret, body));
  const got = Buffer.from(header.trim());
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/** Commit messages containing one of these markers don't trigger deployments. */
export const SKIP_MARKERS = ["[skip ci]", "[ci skip]", "[skip deploy]", "[deploy skip]", "[skip levant]"];
export const hasSkipMarker = (msg?: string | null) => !!msg && SKIP_MARKERS.some((m) => msg.toLowerCase().includes(m));

export type RoutableProject = {
  id: string;
  productionBranch: string;
  previewDeployments: boolean;
  autoDeploy: boolean;
  pausedAt?: Date | string | null;
};

export type DeployAction = {
  type: "deploy";
  projectId: string;
  target: "PRODUCTION" | "PREVIEW";
  trigger: "GIT_PUSH" | "PULL_REQUEST";
  branch: string;
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAuthorAvatar: string | null;
  prNumber: number | null;
};
export type CleanupAction = { type: "pr-closed"; projectId: string; prNumber: number; branch: string; merged: boolean } | { type: "branch-deleted"; projectId: string; branch: string };
export type SkipAction = { type: "skip"; projectId: string | null; reason: string };
export type InstallationAction = {
  type: "installation";
  action: string;
  installationId: number;
  account: { login: string; type: string; avatar_url?: string } | null;
  repositorySelection?: string;
};
export type RouteAction = DeployAction | CleanupAction | SkipAction | InstallationAction;

// Loose payload typings (only the fields we use).
type Commit = { id: string; message: string; author?: { name?: string; username?: string } };
export type PushPayload = {
  ref: string;
  after: string;
  deleted?: boolean;
  created?: boolean;
  head_commit?: Commit | null;
  repository: { id: number; full_name: string };
  sender?: { login?: string; avatar_url?: string };
  installation?: { id: number };
};
export type PullRequestPayload = {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    merged?: boolean;
    draft?: boolean;
    user?: { login?: string; avatar_url?: string };
    head: { ref: string; sha: string; repo: { id: number; full_name: string } | null };
    base: { ref: string; repo: { id: number; full_name: string } };
  };
  repository: { id: number; full_name: string };
  sender?: { login?: string; avatar_url?: string };
  installation?: { id: number };
};
export type DeletePayload = { ref: string; ref_type: "branch" | "tag"; repository: { id: number; full_name: string }; installation?: { id: number } };

export const branchFromRef = (ref: string) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null);

export function routeGitHubEvent(event: string, payload: unknown, projects: RoutableProject[]): RouteAction[] {
  switch (event) {
    case "push":
      return routePush(payload as PushPayload, projects);
    case "pull_request":
      return routePullRequest(payload as PullRequestPayload, projects);
    case "delete": {
      const p = payload as DeletePayload;
      if (p.ref_type !== "branch") return [{ type: "skip", projectId: null, reason: "tag deleted" }];
      return projects.map((pr) => ({ type: "branch-deleted" as const, projectId: pr.id, branch: p.ref.replace(/^refs\/heads\//, "") }));
    }
    case "installation":
    case "installation_repositories": {
      const p = payload as { action: string; installation: { id: number; account: InstallationAction["account"]; repository_selection?: string } };
      return [
        {
          type: "installation",
          action: `${event}.${p.action}`,
          installationId: p.installation.id,
          account: p.installation.account,
          repositorySelection: p.installation.repository_selection,
        },
      ];
    }
    case "ping":
      return [{ type: "skip", projectId: null, reason: "ping" }];
    default:
      return [{ type: "skip", projectId: null, reason: `unhandled event ${event}` }];
  }
}

function inactive(p: RoutableProject): string | null {
  if (p.pausedAt) return "project paused";
  if (!p.autoDeploy) return "auto-deploy disabled";
  return null;
}

function routePush(p: PushPayload, projects: RoutableProject[]): RouteAction[] {
  const branch = branchFromRef(p.ref);
  if (!branch) return [{ type: "skip", projectId: null, reason: "not a branch push" }];
  if (p.deleted || /^0+$/.test(p.after)) {
    return projects.map((pr) => ({ type: "branch-deleted" as const, projectId: pr.id, branch }));
  }
  const msg = p.head_commit?.message ?? null;
  if (hasSkipMarker(msg)) return projects.map((pr) => ({ type: "skip" as const, projectId: pr.id, reason: "skip marker in commit message" }));
  const out: RouteAction[] = [];
  for (const pr of projects) {
    const why = inactive(pr);
    if (why) {
      out.push({ type: "skip", projectId: pr.id, reason: why });
      continue;
    }
    const isProd = branch === pr.productionBranch;
    if (!isProd && !pr.previewDeployments) {
      out.push({ type: "skip", projectId: pr.id, reason: "preview deployments disabled" });
      continue;
    }
    out.push({
      type: "deploy",
      projectId: pr.id,
      target: isProd ? "PRODUCTION" : "PREVIEW",
      trigger: "GIT_PUSH",
      branch,
      commitSha: p.head_commit?.id ?? p.after,
      commitMessage: msg,
      commitAuthor: p.head_commit?.author?.username ?? p.head_commit?.author?.name ?? p.sender?.login ?? null,
      commitAuthorAvatar: p.sender?.avatar_url ?? null,
      prNumber: null,
    });
  }
  return out;
}

function routePullRequest(p: PullRequestPayload, projects: RoutableProject[]): RouteAction[] {
  const pr = p.pull_request;
  const branch = pr.head.ref;
  if (p.action === "closed") {
    return projects.map((x) => ({ type: "pr-closed" as const, projectId: x.id, prNumber: pr.number, branch, merged: !!pr.merged }));
  }
  if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action)) {
    return [{ type: "skip", projectId: null, reason: `pull_request.${p.action} ignored` }];
  }
  // Forks: their code would run with this project's preview env vars/secrets → not deployed automatically.
  if (!pr.head.repo || pr.head.repo.id !== p.repository.id) {
    return projects.map((x) => ({ type: "skip" as const, projectId: x.id, reason: "pull request from a fork" }));
  }
  if (hasSkipMarker(pr.title)) return projects.map((x) => ({ type: "skip" as const, projectId: x.id, reason: "skip marker in PR title" }));
  const out: RouteAction[] = [];
  for (const x of projects) {
    const why = inactive(x);
    if (why) {
      out.push({ type: "skip", projectId: x.id, reason: why });
      continue;
    }
    if (!x.previewDeployments) {
      out.push({ type: "skip", projectId: x.id, reason: "preview deployments disabled" });
      continue;
    }
    // A PR whose head is the production branch itself is already deployed to production by the push.
    if (branch === x.productionBranch) {
      out.push({ type: "skip", projectId: x.id, reason: "head is the production branch" });
      continue;
    }
    out.push({
      type: "deploy",
      projectId: x.id,
      target: "PREVIEW",
      trigger: "PULL_REQUEST",
      branch,
      commitSha: pr.head.sha,
      commitMessage: pr.title,
      commitAuthor: p.sender?.login ?? pr.user?.login ?? null,
      commitAuthorAvatar: p.sender?.avatar_url ?? pr.user?.avatar_url ?? null,
      prNumber: pr.number,
    });
  }
  return out;
}
