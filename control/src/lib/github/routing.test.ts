import { describe, it, expect } from "vitest";
import { signPayload, verifySignature, routeGitHubEvent, hasSkipMarker, type RoutableProject } from "./routing";
import { renderPrComment } from "./status-render";

const secret = "s3cret-webhook";
const proj = (over: Partial<RoutableProject> = {}): RoutableProject => ({ id: "p1", productionBranch: "main", previewDeployments: true, autoDeploy: true, pausedAt: null, ...over });
const push = (ref: string, msg = "feat: x", extra: Record<string, unknown> = {}) => ({
  ref,
  after: "a".repeat(40),
  head_commit: { id: "a".repeat(40), message: msg, author: { name: "Rafic", username: "rafic" } },
  repository: { id: 42, full_name: "o/r" },
  sender: { login: "rafic", avatar_url: "https://avatars/x" },
  ...extra,
});
const pr = (action: string, over: Record<string, unknown> = {}) => ({
  action,
  number: 7,
  pull_request: {
    number: 7,
    title: "Add feature",
    merged: false,
    head: { ref: "feature/x", sha: "b".repeat(40), repo: { id: 42, full_name: "o/r" } },
    base: { ref: "main", repo: { id: 42, full_name: "o/r" } },
    ...over,
  },
  repository: { id: 42, full_name: "o/r" },
  sender: { login: "dev" },
});

describe("webhook signature", () => {
  const body = JSON.stringify({ hello: "world" });
  it("accepts a valid X-Hub-Signature-256", () => {
    expect(verifySignature(secret, body, signPayload(secret, body))).toBe(true);
  });
  it("rejects tampered bodies, wrong secrets, missing or malformed headers", () => {
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body + " ", sig)).toBe(false);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature(secret, body, null)).toBe(false);
    expect(verifySignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifySignature(secret, body, sig.slice(0, -1))).toBe(false);
    expect(verifySignature("", body, sig)).toBe(false);
  });
  it("matches GitHub's documented test vector", () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    expect(signPayload("It's a Secret to Everybody", "Hello, World!")).toBe("sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  });
});

describe("push routing", () => {
  it("production branch → PRODUCTION", () => {
    const [a] = routeGitHubEvent("push", push("refs/heads/main"), [proj()]);
    expect(a).toMatchObject({ type: "deploy", target: "PRODUCTION", trigger: "GIT_PUSH", branch: "main", commitSha: "a".repeat(40), commitAuthor: "rafic", prNumber: null });
  });
  it("other branch → PREVIEW (if previews enabled)", () => {
    expect(routeGitHubEvent("push", push("refs/heads/dev"), [proj()])[0]).toMatchObject({ type: "deploy", target: "PREVIEW", branch: "dev" });
    expect(routeGitHubEvent("push", push("refs/heads/dev"), [proj({ previewDeployments: false })])[0]).toMatchObject({ type: "skip", reason: "preview deployments disabled" });
  });
  it("respects per-project production branch for monorepos with several projects", () => {
    const r = routeGitHubEvent("push", push("refs/heads/release"), [proj({ id: "a" }), proj({ id: "b", productionBranch: "release" })]);
    expect(r.map((x) => (x.type === "deploy" ? `${x.projectId}:${x.target}` : x.type))).toEqual(["a:PREVIEW", "b:PRODUCTION"]);
  });
  it("skip markers", () => {
    for (const m of ["fix [skip ci]", "chore: bump [SKIP DEPLOY]", "[ci skip] docs"]) {
      expect(hasSkipMarker(m)).toBe(true);
      expect(routeGitHubEvent("push", push("refs/heads/main", m), [proj()])[0]!.type).toBe("skip");
    }
    expect(hasSkipMarker("skip the ci please")).toBe(false);
  });
  it("tags and branch deletions", () => {
    expect(routeGitHubEvent("push", push("refs/tags/v1"), [proj()])[0]).toMatchObject({ type: "skip", reason: "not a branch push" });
    expect(routeGitHubEvent("push", push("refs/heads/dev", "x", { deleted: true, after: "0".repeat(40), head_commit: null }), [proj()])[0]).toMatchObject({ type: "branch-deleted", branch: "dev" });
  });
  it("paused / auto-deploy off", () => {
    expect(routeGitHubEvent("push", push("refs/heads/main"), [proj({ autoDeploy: false })])[0]).toMatchObject({ type: "skip", reason: "auto-deploy disabled" });
    expect(routeGitHubEvent("push", push("refs/heads/main"), [proj({ pausedAt: new Date() })])[0]).toMatchObject({ type: "skip", reason: "project paused" });
  });
  it("no linked project → no actions", () => {
    expect(routeGitHubEvent("push", push("refs/heads/main"), [])).toEqual([]);
  });
});

describe("pull_request routing", () => {
  it("opened / synchronize / reopened → PREVIEW with prNumber", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      expect(routeGitHubEvent("pull_request", pr(action), [proj()])[0]).toMatchObject({
        type: "deploy",
        target: "PREVIEW",
        trigger: "PULL_REQUEST",
        prNumber: 7,
        branch: "feature/x",
        commitSha: "b".repeat(40),
      });
    }
  });
  it("closed → pr-closed cleanup (merged flag kept)", () => {
    expect(routeGitHubEvent("pull_request", pr("closed", { merged: true }), [proj()])[0]).toMatchObject({ type: "pr-closed", prNumber: 7, merged: true });
  });
  it("forks are never auto-deployed", () => {
    const fork = pr("opened", { head: { ref: "patch-1", sha: "c".repeat(40), repo: { id: 99, full_name: "evil/r" } } });
    expect(routeGitHubEvent("pull_request", fork, [proj()])[0]).toMatchObject({ type: "skip", reason: "pull request from a fork" });
  });
  it("other actions ignored; head = production branch skipped", () => {
    expect(routeGitHubEvent("pull_request", pr("labeled"), [proj()])[0]!.type).toBe("skip");
    const fromMain = pr("opened", { head: { ref: "main", sha: "d".repeat(40), repo: { id: 42, full_name: "o/r" } } });
    expect(routeGitHubEvent("pull_request", fromMain, [proj()])[0]).toMatchObject({ type: "skip", reason: "head is the production branch" });
  });
});

describe("other events", () => {
  it("delete branch / tag", () => {
    expect(routeGitHubEvent("delete", { ref: "dev", ref_type: "branch", repository: { id: 42, full_name: "o/r" } }, [proj()])[0]).toMatchObject({ type: "branch-deleted", branch: "dev" });
    expect(routeGitHubEvent("delete", { ref: "v1", ref_type: "tag", repository: { id: 42, full_name: "o/r" } }, [proj()])[0]!.type).toBe("skip");
  });
  it("installation events", () => {
    const a = routeGitHubEvent("installation", { action: "created", installation: { id: 5, account: { login: "acme", type: "Organization" }, repository_selection: "all" } }, []);
    expect(a[0]).toMatchObject({ type: "installation", action: "installation.created", installationId: 5 });
    expect(routeGitHubEvent("installation_repositories", { action: "added", installation: { id: 5, account: null } }, [])[0]).toMatchObject({ action: "installation_repositories.added" });
  });
  it("ping + unknown", () => {
    expect(routeGitHubEvent("ping", {}, [])[0]).toMatchObject({ type: "skip", reason: "ping" });
    expect(routeGitHubEvent("issues", {}, [])[0]!.type).toBe("skip");
  });
});

describe("PR comment", () => {
  it("renders one row per project with preview link only when ready", () => {
    const body = renderPrComment(
      [
        { project: "web", status: "READY", inspectUrl: "https://d/i1", previewUrl: "https://web-abc.levant.app", branchUrl: null, updatedAt: Date.UTC(2026, 0, 2, 10, 5) },
        { project: "api", status: "BUILDING", inspectUrl: "https://d/i2", previewUrl: "https://api-x.levant.app", branchUrl: null, updatedAt: Date.UTC(2026, 0, 2, 10, 6) },
      ],
      "https://deploy.example.com",
    );
    expect(body).toContain("<!-- levantdeploy:pr-comment -->");
    expect(body.indexOf("**api**")).toBeLessThan(body.indexOf("**web**"));
    expect(body).toContain("[Visit Preview](https://web-abc.levant.app)");
    expect(body).not.toContain("[Visit Preview](https://api-x.levant.app)");
    expect(body).toContain("Jan 2, 2026");
  });
});
