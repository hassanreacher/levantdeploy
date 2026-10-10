/**
 * Builds every app in ../examples through the real build engine (upload source → detect → docker build),
 * runs each image briefly and curls it, then prints a pass/fail table.
 *
 *   cd control
 *   npx tsx --env-file=.env.build scripts/build-examples.ts                  # all examples
 *   npx tsx --env-file=.env.build scripts/build-examples.ts node-express go-http
 *   npx tsx --env-file=.env.build scripts/build-examples.ts --git            # + clone path (local bare repo over file://)
 *   npx tsx --env-file=.env.build scripts/build-examples.ts --worker         # + full queue path (BullMQ build worker → DEPLOYING + deploy job)
 *   npx tsx --env-file=.env.build scripts/build-examples.ts --app=/path/to/app --name=levantmart   # any folder (copied first)
 *   flags: --keep (keep images/containers) --prune (remove pulled base images + build cache after each example)
 *          --deploy (after the build, run the runtime area's deploy step and count the deployment's containers)
 *          --branch-only (git mode: deploy a branch without commit sha) --no-cache (meta.noCache on git deployments)
 *          --env=K=V,K2=V2 (secret project env vars, also passed to the test container) --any-status (any HTTP answer = booted)
 *          --mirror=mirror.gcr.io (Docker Hub mirror for generated base images; "none" to unset)
 *          --proxy (configure the build proxy setting from $HTTPS_PROXY + /root/.ccr/ca-bundle.crt) --print-dockerfile
 *
 * Containers/images/projects are prefixed "build-" / "levant/<projectId>" and removed at the end.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { setSetting, getSetting } from "@/lib/settings";
import { createDeployment } from "@/lib/deployments";
import { buildDeployment } from "@/lib/build/engine";
import { readLogs } from "@/lib/logs";
import { closeQueues } from "@/lib/queues";
import { encryptString } from "@/lib/crypto";

const EXAMPLES_DIR = path.resolve(__dirname, "../../examples");
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(`--${f}`);
const opt = (f: string) => args.find((a) => a.startsWith(`--${f}=`))?.split("=").slice(1).join("=");
const only = args.filter((a) => !a.startsWith("--"));

type Row = { name: string; framework: string; status: string; build: string; size: string; run: string; note: string };
const rows: Row[] = [];

/** expected response substring per example (default "LevantDeploy") */
const EXPECT: Record<string, string> = { "static-html": "static site", "vite-react": '<div id="root">', nextjs: "Next.js on LevantDeploy" };
/** heavy examples last */
const ORDER = [
  "static-html",
  "node-express",
  "dockerfile-custom",
  "go-http",
  "python-fastapi",
  "flask",
  "python-django-min",
  "php-plain",
  "vite-react",
  "bun-min",
  "deno-min",
  "compose-app",
  "ruby-sinatra",
  "nextjs",
  "rust-axum",
  "dotnet-min",
  "java-spring-min",
];

function sh(cmd: string, a: string[], quiet = true) {
  const r = spawnSync(cmd, a, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function dockerImages(): Set<string> {
  return new Set(sh("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]).out.split("\n").filter(Boolean));
}

async function ensureProxySetting() {
  const ca = "/root/.ccr/ca-bundle.crt";
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!httpsProxy) return console.log("(no HTTPS_PROXY in env — build proxy not configured)");
  await setSetting("build.proxy", {
    httpsProxy,
    noProxy: process.env.NO_PROXY || process.env.no_proxy || "localhost,127.0.0.1",
    caCertPem: fs.existsSync(ca) ? fs.readFileSync(ca, "utf8") : undefined,
    network: "host",
  });
  console.log(`build proxy configured: ${httpsProxy.replace(/\/\/[^@/]+@/, "//***@")} + CA, network host`);
}

async function teamAndUser() {
  const team = await db.team.findFirst({ where: { slug: "admin" } });
  const user = await db.user.findFirst({ where: { email: "admin@levantdeploy.local" } });
  if (!team || !user) throw new Error("Seed the build DB first (npm run db:seed)");
  return { team, user };
}

async function makeTarball(srcDir: string, name: string): Promise<{ rel: string; size: number }> {
  const storage = path.resolve(process.env.STORAGE_DIR || "./storage");
  await fsp.mkdir(path.join(storage, "uploads"), { recursive: true });
  const rel = path.join("uploads", `build-ex-${name}-${Date.now()}.tar.gz`);
  execFileSync("tar", ["czf", path.join(storage, rel), "--exclude=node_modules", "--exclude=.next", "--exclude=target", "--exclude=.git", "-C", srcDir, "."]);
  return { rel, size: fs.statSync(path.join(storage, rel)).size };
}

async function projectFor(name: string, extra: Record<string, unknown> = {}) {
  const { team, user } = await teamAndUser();
  const slug = `build-ex-${name}`.slice(0, 50);
  const existing = await db.project.findFirst({ where: { teamId: team.id, slug } });
  if (existing) return db.project.update({ where: { id: existing.id }, data: { buildSettings: {}, framework: null, kind: "WEB", ...extra } });
  return db.project.create({ data: { teamId: team.id, name: slug, slug, sourceType: "UPLOAD", createdById: user.id, ...extra } });
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function curlUntil(url: string, expect: string, timeoutMs = 60_000): Promise<{ ok: boolean; status: number; body: string }> {
  const until = Date.now() + timeoutMs;
  let last = { ok: false, status: 0, body: "" };
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body = await r.text();
      // --any-status: any HTTP answer proves the server booted (apps whose pages need a database)
      last = { ok: (flag("any-status") || r.ok) && body.includes(expect), status: r.status, body: body.slice(0, 200) };
      if (last.ok) return last;
    } catch (e) {
      last = { ok: false, status: 0, body: (e as Error).message };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function runAndCheck(name: string, image: string, port: number, compose?: { services: Array<{ name: string; image: string }>; primary: string }): Promise<{ ok: boolean; note: string }> {
  const hostPort = await freePort();
  const containers: string[] = [];
  const net = `build-ex-net-${name}`;
  try {
    if (compose) {
      sh("docker", ["network", "create", net]);
      for (const s of compose.services) {
        if (s.name === compose.primary) continue;
        const cname = `build-ex-${name}-${s.name}`;
        sh("docker", ["rm", "-f", cname]);
        const r = sh("docker", ["run", "-d", "--name", cname, "--network", net, "--network-alias", s.name, s.image]);
        if (r.code !== 0) return { ok: false, note: `sidecar ${s.name}: ${r.out.trim().slice(-120)}` };
        containers.push(cname);
      }
    }
    const cname = `build-ex-${name}`;
    sh("docker", ["rm", "-f", cname]);
    const runArgs = ["run", "-d", "--init", "--name", cname, "-e", `PORT=${port}`, "-p", `127.0.0.1:${hostPort}:${port}`, "--memory", "1g"];
    if (compose) runArgs.push("--network", net, "-e", "REDIS_URL=redis://redis:6379");
    for (const kv of opt("env")?.split(",") ?? []) runArgs.push("-e", kv);
    const r = sh("docker", [...runArgs, image]);
    if (r.code !== 0) return { ok: false, note: r.out.trim().slice(-200) };
    containers.push(cname);
    const res = await curlUntil(`http://127.0.0.1:${hostPort}/`, EXPECT[name] ?? "LevantDeploy", name.includes("spring") || name.includes("dotnet") ? 90_000 : 60_000);
    let note = `HTTP ${res.status}`;
    if (name === "vite-react" || name === "static-html") {
      // SPA fallback / pretty URLs
      const deep = await curlUntil(`http://127.0.0.1:${hostPort}/${name === "vite-react" ? "some/client/route" : "about"}`, name === "vite-react" ? '<div id="root">' : "About", 5000);
      note += deep.ok ? `, ${name === "vite-react" ? "SPA fallback" : "/about"} ok` : `, deep route failed (${deep.status})`;
      if (!deep.ok) return { ok: false, note };
    }
    if (!res.ok) {
      const logs = sh("docker", ["logs", "--tail", "15", cname]).out;
      console.log(`--- ${name} container logs ---\n${logs}`);
      return { ok: false, note: `${note}: ${res.body.slice(0, 100)}` };
    }
    const user = sh("docker", ["exec", cname, "id", "-u"]).out.trim();
    return { ok: true, note: `${note}${compose ? " (redis sidecar)" : ""}${user ? `, uid ${user}` : ""}` };
  } finally {
    if (!flag("keep")) {
      for (const c of containers) sh("docker", ["rm", "-f", c]);
      if (compose) sh("docker", ["network", "rm", net]);
    }
  }
}

const fmtMs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);
const fmtSize = (n?: number) => (n ? `${(n / 1024 / 1024).toFixed(0)} MB` : "-");

async function buildOne(name: string, srcDir: string, opts: { git?: boolean; settings?: Record<string, unknown> } = {}) {
  console.log(`\n━━━ ${name} ━━━`);
  const before = dockerImages();
  let project;
  let dep;
  if (opts.git) {
    // local bare repo served over file:// → exercises the shallow clone path (fetch by sha)
    const bare = path.join(os.tmpdir(), `build-ex-git-${name}.git`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "build-ex-git-"));
    execFileSync("cp", ["-a", `${srcDir}/.`, work]);
    const g = (a: string[], cwd = work) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Levant", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "Levant", GIT_COMMITTER_EMAIL: "l@x" } }).toString().trim();
    g(["init", "-q", "-b", "main"]);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "initial import"]);
    fs.writeFileSync(path.join(work, "EXTRA.md"), "second commit");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "second commit"]);
    const sha = g(["rev-parse", "HEAD~1"]);
    fs.rmSync(bare, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", "--bare", work, bare]);
    execFileSync("git", ["config", "uploadpack.allowReachableSHA1InWant", "true"], { cwd: bare });
    project = await projectFor(name, { sourceType: "GIT", gitUrl: `file://${bare}`, productionBranch: "main", ...(opts.settings ? { buildSettings: opts.settings } : {}) });
    // --branch-only: like the Deploy button (branch, no commit) → the engine resolves the head with ls-remote
    dep = await createDeployment({
      projectId: project.id,
      target: "PREVIEW",
      source: flag("branch-only") ? { branch: "main" } : { branch: "main", commitSha: sha },
      trigger: "API",
      enqueue: false,
      meta: flag("no-cache") ? { noCache: true } : {},
    });
    fs.rmSync(work, { recursive: true, force: true });
  } else {
    const { rel, size } = await makeTarball(srcDir, name);
    project = await projectFor(name, opts.settings ? { buildSettings: opts.settings } : {});
    // --env=K=V,K2=V2 → secret project env vars (exercises the BuildKit secret path)
    if (opt("env")) {
      await db.envVar.deleteMany({ where: { projectId: project.id } });
      for (const kv of opt("env")!.split(",")) {
        const [k, ...v] = kv.split("=");
        await db.envVar.create({ data: { projectId: project.id, key: k!, valueEnc: encryptString(v.join("=")), isSecret: true } });
      }
    }
    const { team, user } = await teamAndUser();
    const up = await db.upload.create({ data: { teamId: team.id, projectId: project.id, userId: user.id, path: rel, size, status: "COMPLETE", expiresAt: new Date(Date.now() + 86400_000) } });
    dep = await createDeployment({ projectId: project.id, target: "PRODUCTION", source: { uploadId: up.id }, trigger: "CLI", enqueue: false });
  }
  const res = await buildDeployment(dep.id, { enqueueDeploy: false });
  const logs = await readLogs(dep.id, "BUILD", { limit: 10000 });
  const detected = logs.lines.find((l) => l.line.includes("Detected "))?.line.replace(/^\s+/, "") ?? "";
  console.log(`  ${detected}`);
  if (res.status !== "DEPLOYING") {
    console.log(logs.lines.slice(-40).map((l) => `  | ${l.line}`).join("\n"));
    rows.push({ name, framework: detected.replace(/^Detected /, "").slice(0, 40), status: "BUILD FAIL", build: fmtMs(res.durationMs), size: "-", run: "-", note: res.status === "ERROR" ? `${res.errorStep}: ${res.errorMessage.split("\n").pop()!.slice(0, 120)}` : res.reason });
  } else {
    if (flag("print-dockerfile")) console.log(logs.lines.filter((l) => l.line.startsWith("  #") || l.line.startsWith("  FROM")).map((l) => l.line).join("\n"));
    const meta = res.meta;
    console.log(`  built ${res.imageTag} in ${fmtMs(res.durationMs)} (${fmtSize(meta.imageSize)})`);
    const compose = meta.kind === "COMPOSE" ? { services: (meta.compose ?? []).map((s) => ({ name: s.name, image: s.image })), primary: meta.composePrimary ?? "web" } : undefined;
    if (flag("deploy")) {
      // full path: the runtime area's deploy step (containers + health) — Caddy is not needed (sync errors are logged)
      const { runDeploy, removeDeploymentContainers } = await import("@/lib/runtime/deploy");
      await runDeploy(dep.id).catch((e) => console.log(`  runDeploy threw: ${(e as Error).message}`));
      const after = await db.deployment.findUnique({ where: { id: dep.id }, include: { project: { select: { kind: true, framework: true } } } });
      const live = sh("docker", ["ps", "--filter", `label=levant.deployment=${dep.id}`, "--format", "{{.Names}} {{.Image}}"]).out.trim().split("\n").filter(Boolean);
      console.log(`  deploy: status ${after?.status}${after?.errorMessage ? ` (${after.errorMessage.slice(0, 160)})` : ""}; project kind ${after?.project.kind}, framework ${after?.project.framework}`);
      for (const c of live) console.log(`    container ${c}`);
      const expected = meta.kind === "COMPOSE" ? (meta.compose ?? []).length : 1;
      const ok = after?.status === "READY" && live.length === expected;
      rows.push({ name: `${name} (deploy)`, framework: meta.frameworkName, status: ok ? "PASS" : "DEPLOY FAIL", build: fmtMs(res.durationMs), size: fmtSize(meta.imageSize), run: ok ? "ok" : "fail", note: `${after?.status}, project kind ${after?.project.kind}, ${live.length}/${expected} containers` });
      const plain = await db.deployment.findUnique({ where: { id: dep.id } });
      if (!flag("keep") && plain) await removeDeploymentContainers(plain).catch(() => {});
      if (!flag("keep")) for (const s of compose?.services.filter((x) => x.image.startsWith("levant/")) ?? [{ image: res.imageTag }]) sh("docker", ["image", "rm", "-f", s.image]);
      return;
    }
    const run = await runAndCheck(name, res.imageTag, meta.port, compose);
    console.log(`  run: ${run.ok ? "PASS" : "FAIL"} ${run.note}`);
    rows.push({ name, framework: meta.frameworkName, status: run.ok ? "PASS" : "RUN FAIL", build: fmtMs(res.durationMs), size: fmtSize(meta.imageSize), run: run.ok ? "ok" : "fail", note: run.note.slice(0, 120) });
    if (!flag("keep")) for (const s of compose?.services.filter((x) => x.image.startsWith("levant/")) ?? [{ image: res.imageTag }]) sh("docker", ["image", "rm", "-f", s.image]);
  }
  await db.deployment.findUnique({ where: { id: dep.id } }).then((d) => console.log(`  deployment status: ${d?.status}${d?.errorStep ? ` (${d.errorStep})` : ""}`));
  if (flag("prune")) {
    const after = dockerImages();
    for (const img of after) if (!before.has(img) && !img.startsWith("<none>")) sh("docker", ["image", "rm", img]);
    sh("docker", ["builder", "prune", "-f", "--filter", "until=1m"]);
  }
}

async function workerPath() {
  console.log(`\n━━━ queue path (BullMQ build worker) ━━━`);
  const { Worker } = await import("bullmq");
  const { bullConnection, QUEUE_PREFIX, getRegisteredProcessors, queues } = await import("@/lib/queues");
  await import("@/worker/processors/build");
  const p = getRegisteredProcessors().find((x) => x.queue === "build")!;
  const w = new Worker("build", p.fn, { connection: bullConnection(), prefix: QUEUE_PREFIX, concurrency: 2 });
  const project = await projectFor("queue");
  const { rel, size } = await makeTarball(path.join(EXAMPLES_DIR, "static-html"), "queue");
  const { team } = await teamAndUser();
  const up = await db.upload.create({ data: { teamId: team.id, projectId: project.id, path: rel, size, status: "COMPLETE", expiresAt: new Date(Date.now() + 86400_000) } });
  const t = Date.now();
  const dep = await createDeployment({ projectId: project.id, target: "PRODUCTION", source: { uploadId: up.id }, trigger: "API" });
  let status = "QUEUED";
  while (Date.now() - t < 180_000) {
    status = (await db.deployment.findUnique({ where: { id: dep.id } }))!.status;
    if (!["QUEUED", "BUILDING"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const deployJob = await queues.deploy.raw.getJob(`deploy-${dep.id}`);
  const ok = status === "DEPLOYING" && !!deployJob;
  console.log(`  status ${status}, deploy job ${deployJob ? "enqueued" : "missing"} (${fmtMs(Date.now() - t)})`);
  rows.push({ name: "queue → worker", framework: "Static HTML", status: ok ? "PASS" : "FAIL", build: fmtMs(Date.now() - t), size: "-", run: "-", note: `status ${status}, deploy job ${deployJob ? "enqueued" : "missing"}` });
  await deployJob?.remove().catch(() => {});
  const d = await db.deployment.findUnique({ where: { id: dep.id } });
  if (d?.imageTag && !flag("keep")) sh("docker", ["image", "rm", "-f", d.imageTag]);

  // cancellation: cancel while building → CANCELED and the docker build is killed
  const proj2 = await projectFor("cancel");
  const tb = await makeTarball(path.join(EXAMPLES_DIR, "python-fastapi"), "cancel");
  const up2 = await db.upload.create({ data: { teamId: team.id, projectId: proj2.id, path: tb.rel, size: tb.size, status: "COMPLETE", expiresAt: new Date(Date.now() + 86400_000) } });
  await db.project.update({ where: { id: proj2.id }, data: { buildSettings: { buildCommand: "sleep 120" } } });
  const dep2 = await createDeployment({ projectId: proj2.id, target: "PREVIEW", source: { uploadId: up2.id }, trigger: "API" });
  const t2 = Date.now();
  while (Date.now() - t2 < 120_000) {
    const logs = await readLogs(dep2.id, "BUILD", { limit: 5000 });
    if (logs.lines.some((l) => l.line.includes("sleep 120"))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const { cancelDeployment } = await import("@/lib/deployments");
  await cancelDeployment(dep2.id);
  const tc = Date.now();
  let ended = false;
  while (Date.now() - tc < 30_000) {
    const logs = await readLogs(dep2.id, "BUILD", { limit: 5000 });
    if (logs.ended) {
      ended = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const s2 = (await db.deployment.findUnique({ where: { id: dep2.id } }))!.status;
  const buildProcs = sh("pgrep", ["-f", `levant.deployment=${dep2.id}`]).out.trim();
  const okc = s2 === "CANCELED" && ended && !buildProcs;
  console.log(`  cancel: status ${s2}, logs ended ${ended}, docker build process ${buildProcs ? "still running" : "killed"} (${fmtMs(Date.now() - tc)} after cancel)`);
  rows.push({ name: "cancel during build", framework: "FastAPI", status: okc ? "PASS" : "FAIL", build: fmtMs(Date.now() - tc), size: "-", run: "-", note: `status ${s2}, build killed ${!buildProcs}` });
  await w.close();
}

async function main() {
  if (flag("proxy") || !(await getSetting("build.proxy")).httpsProxy) await ensureProxySetting();
  if (flag("print-dockerfile")) process.env.LEVANT_BUILD_PRINT_DOCKERFILE = "1";
  // Docker Hub pull-through mirror for generated Dockerfiles' base images (e.g. --mirror=mirror.gcr.io, --mirror=none)
  if (opt("mirror")) await setSetting("build.registryMirror", opt("mirror") === "none" ? null : opt("mirror")!);
  const app = opt("app");
  if (app) {
    // copy (never modify the original), without heavy dirs
    const name = opt("name") ?? path.basename(app);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), `build-ex-${name}-`));
    execFileSync("sh", ["-c", `tar cf - --exclude=node_modules --exclude=.next --exclude=.git --exclude='.env*' -C "${app}" . | tar xf - -C "${copy}"`]);
    EXPECT[name] = opt("expect") ?? "<";
    await buildOne(name, copy, { settings: opt("settings") ? JSON.parse(opt("settings")!) : undefined });
    fs.rmSync(copy, { recursive: true, force: true });
  } else {
    const names = only.length ? only : ORDER.filter((n) => fs.existsSync(path.join(EXAMPLES_DIR, n)));
    for (const n of names) {
      try {
        await buildOne(n, path.join(EXAMPLES_DIR, n));
      } catch (e) {
        rows.push({ name: n, framework: "?", status: "CRASH", build: "-", size: "-", run: "-", note: (e as Error).message.slice(0, 120) });
      }
    }
    if (flag("git")) await buildOne("git-node-express", path.join(EXAMPLES_DIR, "node-express"), { git: true });
  }
  if (flag("worker")) await workerPath();

  console.log("\n" + table(rows));
  const failed = rows.filter((r) => r.status !== "PASS").length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  await closeQueues();
  await redis().quit();
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}

function table(r: Row[]) {
  const cols: (keyof Row)[] = ["name", "framework", "status", "build", "size", "note"];
  const w = cols.map((c) => Math.max(c.length, ...r.map((x) => String(x[c]).length)));
  const line = (vals: string[]) => "| " + vals.map((v, i) => v.padEnd(w[i]!)).join(" | ") + " |";
  return [line(cols.map(String)), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...r.map((x) => line(cols.map((c) => String(x[c]))))].join("\n");
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
