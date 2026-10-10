/**
 * git+cli area end-to-end test against a running instance (default http://localhost:3103) + the fake GitHub (4103).
 *   1. tsx tests/git/e2e.ts setup      → creates bare repos + an RSA key, prints the fake-github command
 *   2. run the fake GitHub + the app (GITHUB_API_URL/GITHUB_WEB_URL → fake, GIT_ALLOW_FILE_URLS=1)
 *   3. tsx --env-file=.env.git tests/git/e2e.ts run
 * Covers: GitHub App credentials (JWT verified by the fake), install callback, repo list, detection over smart HTTP,
 * GitHub import + first deployment, signed webhooks (push prod/preview, PR open/sync dedupe, skip markers, bad signature,
 * duplicate delivery, PR closed → cleanup job), status hook → commit statuses / deployments / PR comment,
 * generic Git (file://) import + polling + deploy hooks, chunked uploads + deploy, CLI device login.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3103";
const GH = process.env.E2E_FAKE_GH || "http://localhost:4103";
const WORK = path.resolve(process.env.E2E_WORK || path.join(os.tmpdir(), "ld-git-e2e"));
const REPOS = path.join(WORK, "fake-gh");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com" } }).toString().trim();

function makeRepo(bare: string, files: Record<string, string>, branches: string[] = []) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ld-src-"));
  git(src, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), c);
  }
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "initial commit");
  for (const b of branches) {
    git(src, "checkout", "-q", "-b", b);
    fs.writeFileSync(path.join(src, `${b}.txt`), b);
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", `work on ${b}`);
    git(src, "checkout", "-q", "main");
  }
  fs.rmSync(bare, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", src, bare]);
  return src;
}

if (process.argv[2] === "setup") {
  fs.mkdirSync(WORK, { recursive: true });
  const site = { "index.html": "<!doctype html><h1>Hello from LevantDeploy</h1>\n", "README.md": "# web\nA tiny static site.\n" };
  makeRepo(path.join(REPOS, "acme", "web.git"), site, ["feature-x"]);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(WORK, "app.pem"), privateKey.export({ type: "pkcs1", format: "pem" }));
  fs.writeFileSync(path.join(WORK, "app.pub"), publicKey.export({ type: "spki", format: "pem" }));
  makeRepo(path.join(WORK, "plain", "site.git"), site, ["staging"]);
  console.log(`FAKE_GH_PRIVATE_KEY=${WORK}/app.pem npx tsx tests/git/fake-github.ts 4103 ${REPOS} ${WORK}/app.pub`);
  process.exit(0);
}

// ───────────────────────────── helpers ─────────────────────────────
let failures = 0;
let passes = 0;
function check(name: string, ok: unknown, extra?: unknown) {
  if (ok) {
    passes++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : "");
  }
}
let cookie = "";
async function call<T = any>(method: string, p: string, body?: unknown, opts: { token?: string; raw?: BodyInit; headers?: Record<string, string>; redirect?: "manual" } = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  else if (cookie) {
    headers.cookie = cookie;
    headers.origin = BASE;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + p, { method, headers, body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: opts.redirect ?? "follow" });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}
const ghCalls = async () => (await (await fetch(`${GH}/__calls`)).json()) as Array<{ method: string; path: string; body: any }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

async function main() {
  const { db } = await import("@/lib/db");
  const { setStatus } = await import("@/lib/deployments");
  const { signPayload } = await import("@/lib/github/routing");
  const { queues } = await import("@/lib/queues");
  const { redis } = await import("@/lib/redis");

  console.log(`\n▶ git+cli e2e against ${BASE} (fake GitHub ${GH})`);
  // clean slate for this area's DB
  await db.project.deleteMany({ where: { slug: { startsWith: "e2e-" } } });
  await db.gitHubInstallation.deleteMany({});
  await redis().flushdb();

  console.log("\n● auth");
  const login = await fetch(BASE + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: "admin@levantdeploy.local", password: "Admin@12345" }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  check("admin login", login.ok && cookie.startsWith("ld_session="));

  console.log("\n● CLI device login");
  const start = await call("POST", "/api/v1/cli/login", { clientName: "levant CLI", hostname: "e2e-host" }, { headers: {} });
  const savedCookie = cookie;
  cookie = "";
  const pending = await call("POST", "/api/v1/cli/login/poll", { deviceCode: start.data.deviceCode });
  cookie = savedCookie;
  check("start returns user code + verification URL", start.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(start.data.userCode) && start.data.verificationUrl.includes("/cli/authorize?code="), start.data);
  check("poll pending → 202", pending.status === 202, pending);
  const desc = await call("GET", `/api/v1/cli/login/${start.data.userCode}`);
  check("authorize page data shows hostname", desc.data.hostname === "e2e-host", desc.data);
  const approve = await call("POST", `/api/v1/cli/login/${start.data.userCode}`, { action: "approve", team: "admin" });
  check("approve", approve.data.status === "approved", approve.data);
  cookie = "";
  const got = await call("POST", "/api/v1/cli/login/poll", { deviceCode: start.data.deviceCode });
  const again = await call("POST", "/api/v1/cli/login/poll", { deviceCode: start.data.deviceCode });
  cookie = savedCookie;
  const TOKEN: string = got.data.token;
  check("poll approved → token once", got.status === 200 && TOKEN?.startsWith("ld_") && got.data.team === "admin", got.data);
  check("token handed out only once", again.status === 410, again);
  const who = await call("GET", "/api/v1/me", undefined, { token: TOKEN });
  check("token works (whoami)", who.status === 200, who.data);

  console.log("\n● GitHub App credentials (manual) — JWT verified by the fake");
  const bad = await call("POST", "/api/v1/github/app", { appId: "999", slug: "x", privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", webhookSecret: "whsec-123456" });
  check("invalid key rejected", bad.status === 422 || bad.status === 400 || bad.status === 500, bad);
  const pem = fs.readFileSync(path.join(WORK, "app.pem"), "utf8");
  const WEBHOOK_SECRET = "whsec-e2e-secret";
  const app = await call("POST", "/api/v1/github/app", { appId: "4242", slug: "levant-test-app", privateKey: pem, webhookSecret: WEBHOOK_SECRET, clientId: null, clientSecret: null });
  check("app configured", app.status === 201 && app.data.configured && app.data.slug === "levant-test-app", app.data);

  console.log("\n● install flow");
  const inst = await call("GET", "/api/v1/github/install?team=admin", undefined, { redirect: "manual" });
  const loc = inst.headers.get("location") ?? "";
  check("install redirects to GitHub with state", inst.status === 307 || inst.status === 302 ? loc.includes("/apps/levant-test-app/installations/new?state=") : false, { status: inst.status, loc });
  const state = new URL(loc).searchParams.get("state");
  const forged = await call("GET", `/api/v1/github/callback?installation_id=77&setup_action=install&state=forged-state-123`, undefined, { redirect: "manual" });
  check("forged state rejected", (forged.headers.get("location") ?? "").includes("github_error"), forged.headers.get("location"));
  const cb = await call("GET", `/api/v1/github/callback?installation_id=77&setup_action=install&state=${state}`, undefined, { redirect: "manual" });
  check("callback links installation", (cb.headers.get("location") ?? "").includes("github_installed=1"), cb.headers.get("location"));
  const insts = await call("GET", "/api/v1/github/installations?team=admin");
  check("installation listed", insts.data.items?.[0]?.installationId === 77 && insts.data.items[0].accountLogin === "acme", insts.data);

  console.log("\n● repo picker + detection");
  const repos = await call("GET", "/api/v1/github/repos?team=admin&installationId=77&q=web");
  const repo = repos.data.items?.[0];
  check("repo search", repo?.fullName === "acme/web", repos.data);
  const det = await call("GET", `/api/v1/github/repos/detect?team=admin&installationId=77&repo=acme/web`);
  check("detection over smart HTTP with installation token → static", det.data.detection?.framework === "static", det.data);

  console.log("\n● import GitHub repo → project + first deployment");
  await fetch(`${GH}/__calls`, { method: "DELETE" });
  const imp = await call("POST", "/api/v1/projects", {
    team: "admin",
    name: "e2e-web",
    framework: "static",
    source: { type: "github", installationId: 77, repoId: repo.id },
    env: [{ key: "GREETING", value: "hello" }],
  });
  check("project created", imp.status === 201 && imp.data.project.slug === "e2e-web" && imp.data.deployment, imp.data);
  const projectId: string = imp.data.project?.id;
  const firstDep = imp.data.deployment ? await db.deployment.findUnique({ where: { id: imp.data.deployment.id } }) : null;
  check("first deployment is PRODUCTION @ main head with commit info", firstDep?.target === "PRODUCTION" && firstDep.branch === "main" && firstDep.commitSha?.length === 40 && firstDep.commitMessage === "initial commit", firstDep);
  check("env var stored encrypted", (await db.envVar.findFirst({ where: { projectId, key: "GREETING" } }))?.valueEnc.startsWith("v1."));
  const c1 = await waitFor(async () => {
    const c = await ghCalls();
    return c.some((x) => x.path.includes("/statuses/")) && c.some((x) => x.path.endsWith("/deployments")) ? c : null;
  });
  check("queued → pending commit status + GitHub deployment created", !!c1, await ghCalls());
  const dup = await call("POST", "/api/v1/projects", { team: "admin", name: "e2e-web", source: { type: "github", installationId: 77, repoId: repo.id } });
  check("duplicate name → 409", dup.status === 409, dup);

  console.log("\n● webhooks");
  const bare = path.join(REPOS, "acme", "web.git");
  const headMain = git(bare, "rev-parse", "refs/heads/main");
  const headFeat = git(bare, "rev-parse", "refs/heads/feature-x");
  let n = 0;
  async function hook(event: string, payload: unknown, opts: { secret?: string; delivery?: string } = {}) {
    const body = JSON.stringify(payload);
    const delivery = opts.delivery ?? `e2e-${Date.now()}-${n++}`;
    return call("POST", "/api/v1/webhooks/github", undefined, {
      raw: body,
      headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signPayload(opts.secret ?? WEBHOOK_SECRET, body) },
    });
  }
  const repoPayload = { id: repo.id, full_name: "acme/web" };
  const pushMain = (sha: string, msg: string) => ({ ref: "refs/heads/main", after: sha, head_commit: { id: sha, message: msg, author: { username: "dev" } }, repository: repoPayload, sender: { login: "dev" }, installation: { id: 77 } });
  const savedCookie2 = cookie;
  cookie = "";
  const sigBad = await hook("push", pushMain(headMain, "x"), { secret: "wrong" });
  check("bad signature → 401", sigBad.status === 401, sigBad);
  const fakeSha = crypto.randomBytes(20).toString("hex");
  const p1 = await hook("push", pushMain(fakeSha, "feat: new hero"), { delivery: "fixed-delivery-1" });
  check("push to main → PRODUCTION deployment", p1.status === 202 && p1.data.results?.[0]?.action === "deploy", p1.data);
  const p1b = await hook("push", pushMain(fakeSha, "feat: new hero"), { delivery: "fixed-delivery-1" });
  check("same delivery id → duplicate, no new deployment", p1b.data.duplicate === true, p1b.data);
  const skip = await hook("push", pushMain(crypto.randomBytes(20).toString("hex"), "docs: typo [skip ci]"));
  check("[skip ci] → skipped", skip.data.results?.[0]?.action === "skip", skip.data);
  const pf = await hook("push", { ref: "refs/heads/feature-x", after: headFeat, head_commit: { id: headFeat, message: "work on feature-x" }, repository: repoPayload, installation: { id: 77 } });
  const prevId = pf.data.results?.[0]?.deploymentId;
  const prevDep = prevId ? await db.deployment.findUnique({ where: { id: prevId } }) : null;
  check("push to feature branch → PREVIEW", prevDep?.target === "PREVIEW" && prevDep.branch === "feature-x", pf.data);
  const prPayload = (action: string, extra: Record<string, unknown> = {}) => ({
    action,
    number: 5,
    pull_request: { number: 5, title: "Feature X", merged: false, head: { ref: "feature-x", sha: headFeat, repo: repoPayload }, base: { ref: "main", repo: repoPayload }, ...extra },
    repository: repoPayload,
    sender: { login: "dev" },
    installation: { id: 77 },
  });
  const pro = await hook("pull_request", prPayload("opened"));
  check("PR opened for an already-deploying commit → same deployment tagged with PR #5", pro.data.results?.[0]?.action === "deploy-dedupe" && pro.data.results[0].deploymentId === prevId, pro.data);
  check("prNumber stored", (await db.deployment.findUnique({ where: { id: prevId } }))?.prNumber === 5);
  const fork = await hook("pull_request", prPayload("opened", { head: { ref: "patch", sha: headFeat, repo: { id: 1, full_name: "evil/web" } } }));
  check("fork PR → not deployed", fork.data.results?.[0]?.reason === "pull request from a fork", fork.data);
  const instEv = await hook("installation_repositories", { action: "added", installation: { id: 77, account: { login: "acme", type: "Organization" }, repository_selection: "selected" } });
  check("installation_repositories event handled", instEv.status === 202 && (await db.gitHubInstallation.findUnique({ where: { installationId: 77 } }))?.repositorySelection === "selected", instEv.data);
  cookie = savedCookie2;

  console.log("\n● status hook → GitHub (commit status, deployment status, PR comment)");
  await fetch(`${GH}/__calls`, { method: "DELETE" });
  await setStatus(prevId, "BUILDING");
  await setStatus(prevId, "DEPLOYING", { imageTag: "e2e:1" });
  await setStatus(prevId, "READY");
  const comment = await waitFor(async () => {
    const c = await ghCalls();
    const last = [...c].reverse().find((x) => x.path.includes("/issues/") && x.body?.body?.includes("Ready"));
    return last ?? null;
  });
  const calls2 = await ghCalls();
  check("commit statuses pending → success", calls2.filter((c) => c.path.includes("/statuses/")).map((c) => c.body.state).includes("success"), calls2.map((c) => `${c.method} ${c.path} ${c.body?.state ?? ""}`));
  check("deployment statuses in_progress → success with environment_url", calls2.some((c) => c.path.match(/deployments\/\d+\/statuses/) && c.body.state === "success" && c.body.environment_url), calls2.filter((c) => c.path.includes("deployments")));
  check("PR comment created then updated in place with Ready + Visit Preview", !!comment && comment.body.body.includes("Visit Preview") && calls2.some((c) => c.method === "PATCH"), calls2.filter((c) => c.path.includes("issues")));
  const prc = await hook("pull_request", prPayload("closed", { merged: true }));
  const job = await waitFor(async () => (await queues.git.raw.getJobs(["waiting", "delayed", "active", "completed"])).find((j) => j.data.kind === "pr-closed" && j.data.prNumber === 5));
  check("PR closed → git cleanup job queued", prc.status === 202 && !!job, prc.data);
  const { stopPreviews } = await import("@/lib/git/runtime-adapter");
  const stopped = await stopPreviews(projectId, { prNumber: 5 });
  check("cleanup stops the PR preview", stopped.includes(prevId) && !!(await db.deployment.findUnique({ where: { id: prevId } }))?.stoppedAt, stopped);

  console.log("\n● generic Git URL (file://) import, polling, deploy hooks");
  const plain = `file://${path.join(WORK, "plain", "site.git")}`;
  const insp = await call("POST", "/api/v1/git/inspect", { team: "admin", url: plain });
  check("inspect lists branches + detects static", insp.status === 200 && insp.data.branches.includes("staging") && insp.data.defaultBranch === "main" && insp.data.detection?.framework === "static", insp.data);
  const bogus = await call("POST", "/api/v1/git/inspect", { team: "admin", url: "--upload-pack=touch /tmp/pwned" });
  check("option injection rejected", bogus.status === 422, bogus);
  const gimp = await call("POST", "/api/v1/projects", { team: "admin", name: "e2e-plain", source: { type: "git", url: plain, polling: true } }, { token: TOKEN });
  check("git project + first deployment (trigger CLI via token)", gimp.status === 201 && gimp.data.deployment, gimp.data);
  const gid: string = gimp.data.project?.id;
  const gdep = gimp.data.deployment ? await db.deployment.findUnique({ where: { id: gimp.data.deployment.id } }) : null;
  check("first git deployment has the head sha", gdep?.commitSha === git(path.join(WORK, "plain", "site.git"), "rev-parse", "main") && gdep?.trigger === "CLI", gdep);
  const noNew = await call("POST", `/api/v1/projects/${gid}/git/poll`);
  check("poll without new commits → nothing", noNew.status === 200 && noNew.data.deployed.length === 0, noNew.data);
  // push a new commit to main and a new branch
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ld-push-"));
  git(work, "clone", "-q", path.join(WORK, "plain", "site.git"), ".");
  fs.writeFileSync(path.join(work, "index.html"), `<h1>v2 ${Date.now()}</h1>`);
  git(work, "commit", "-qam", "v2");
  git(work, "push", "-q", "origin", "main");
  const feat = `feat-${Date.now().toString(36)}`;
  git(work, "checkout", "-q", "-b", feat);
  git(work, "push", "-q", "origin", feat);
  const polled = await call("POST", `/api/v1/projects/${gid}/git/poll`);
  const polledDeps = await db.deployment.findMany({ where: { id: { in: polled.data.deployed ?? [] } } });
  check("poll after push → PRODUCTION for main + PREVIEW for new branch", polledDeps.length === 2 && polledDeps.some((d) => d.target === "PRODUCTION" && d.branch === "main") && polledDeps.some((d) => d.target === "PREVIEW" && d.branch === feat), polled.data);
  const hk = await call("POST", `/api/v1/projects/${gid}/git/hooks`, { name: "CMS", branch: "staging" });
  check("deploy hook created", hk.status === 201 && hk.data.hook.url.includes(`/api/v1/deploy-hooks/${gid}/`), hk.data);
  cookie = "";
  const fire = await call("POST", new URL(hk.data.hook.url).pathname);
  const wrong = await call("POST", `/api/v1/deploy-hooks/${gid}/${"x".repeat(32)}`);
  cookie = savedCookie2;
  const fired = fire.data.job?.deploymentId ? await db.deployment.findUnique({ where: { id: fire.data.job.deploymentId } }) : null;
  check("deploy hook POST → PREVIEW deployment of staging (trigger API)", fire.status === 201 && fired?.branch === "staging" && fired.target === "PREVIEW" && fired.trigger === "API", fire.data);
  check("wrong hook token → 404", wrong.status === 404, wrong);
  const gv = await call("GET", `/api/v1/projects/${gid}/git`);
  check("git settings view (polling + hooks, no secrets)", gv.data.git?.polling.enabled === true && gv.data.deployHooks.length === 1 && !JSON.stringify(gv.data).includes("tokenEnc"), gv.data);
  const key = await call("POST", `/api/v1/git/deploy-keys`, { team: "admin", url: "git@github.com:acme/private.git" });
  check("pending deploy key for SSH imports", key.status === 201 && key.data.publicKey.startsWith("ssh-ed25519 "), key.data);

  console.log("\n● chunked uploads (CLI style, Bearer token)");
  const files = fs.mkdtempSync(path.join(os.tmpdir(), "ld-up-"));
  fs.writeFileSync(path.join(files, "index.html"), "<h1>uploaded</h1>" + "x".repeat(600_000));
  const tgz = path.join(os.tmpdir(), `ld-up-${Date.now()}.tgz`);
  execFileSync("tar", ["-czf", tgz, "-C", files, "."]);
  const bytes = fs.readFileSync(tgz);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const init = await call("POST", "/api/v1/uploads", { team: "admin", size: bytes.length, chunkSize: 256 * 1024 }, { token: TOKEN });
  check("init upload", init.status === 201 && init.data.totalChunks === Math.ceil(bytes.length / (256 * 1024)), init.data);
  const id = init.data.id;
  const cs = init.data.chunkSize;
  // send chunks out of order, one twice, then check resume info
  const order = [...Array(init.data.totalChunks).keys()].reverse();
  for (const i of order.slice(0, -1)) {
    const r = await call("PUT", `/api/v1/uploads/${id}/chunks/${i}`, undefined, { token: TOKEN, raw: bytes.subarray(i * cs, Math.min(bytes.length, (i + 1) * cs)), headers: { "content-type": "application/octet-stream" } });
    if (r.status !== 200) check(`chunk ${i}`, false, r);
  }
  const early = await call("POST", `/api/v1/uploads/${id}/complete`, { sha256: sha }, { token: TOKEN });
  check("complete with a missing chunk → 409", early.status === 409, early);
  const st = await call("GET", `/api/v1/uploads/${id}`, undefined, { token: TOKEN });
  check("resume info lists received chunks", st.data.received.length === init.data.totalChunks - 1 && !st.data.received.includes(0), st.data);
  const badChunk = await call("PUT", `/api/v1/uploads/${id}/chunks/0`, undefined, { token: TOKEN, raw: bytes.subarray(0, 10), headers: { "content-type": "application/octet-stream" } });
  check("wrong chunk size rejected", badChunk.status === 400, badChunk);
  await call("PUT", `/api/v1/uploads/${id}/chunks/0`, undefined, { token: TOKEN, raw: bytes.subarray(0, cs), headers: { "content-type": "application/octet-stream" } });
  const wrongSha = await call("POST", `/api/v1/uploads/${id}/complete`, { sha256: "0".repeat(64) }, { token: TOKEN });
  check("sha256 mismatch → 400", wrongSha.status === 400, wrongSha);
  const done = await call("POST", `/api/v1/uploads/${id}/complete`, { sha256: sha }, { token: TOKEN });
  check("complete → COMPLETE, file stored", done.data.status === "COMPLETE" && done.data.sha256 === sha, done.data);
  const row = await db.upload.findUnique({ where: { id } });
  const stored = path.join(path.resolve(process.env.STORAGE_DIR || "./storage"), row!.path);
  check("stored tarball matches", fs.existsSync(stored) && crypto.createHash("sha256").update(fs.readFileSync(stored)).digest("hex") === sha, stored);
  const up = await call("POST", "/api/v1/projects", { team: "admin", name: "e2e-upload", source: { type: "upload", uploadId: id } }, { token: TOKEN });
  check("project from upload + deployment with uploadId", up.status === 201 && (await db.deployment.findUnique({ where: { id: up.data.deployment.id } }))?.uploadId === id, up.data);
  const big = await call("POST", "/api/v1/uploads", { team: "admin", size: 50 * 1024 * 1024 * 1024 }, { token: TOKEN });
  check("size limit enforced", big.status === 422, big);
  const tmpl = await call("GET", "/api/v1/templates");
  check("templates endpoint", tmpl.status === 200 && Array.isArray(tmpl.data.items), tmpl.data);
  const list = await call("GET", "/api/v1/projects?team=admin", undefined, { token: TOKEN });
  check("project list (token)", list.data.items?.some((p: any) => p.slug === "e2e-upload" && p.latestDeployment), list.data.items?.map((p: any) => p.slug));

  console.log(`\n${passes} passed, ${failures} failed`);
  await redis().quit();
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
