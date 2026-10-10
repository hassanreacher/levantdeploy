/**
 * Dashboard demo data (screenshots / docs). Idempotent: re-creates the demo projects every run.
 *
 *   npx tsx --env-file=.env scripts/seed-dashboard-demo.ts            (after `npm run db:seed`)
 *
 * Creates (in the admin's "Personal" team, slug "admin"):
 *  - 2 extra members, 6 projects (Next.js, Express, Astro, FastAPI, Go worker, + the seed's demo-app)
 *  - ~90 deployments over the last 2 weeks with realistic statuses, DeploymentEvents and build logs (Redis)
 *  - env vars (secrets, branch overrides), a shared env group, domains, metrics (30 days hourly),
 *    notification channels, in-app notifications and audit entries.
 * Never run against production data: it deletes and re-creates the demo projects listed below.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { DeploymentStatus, DeploymentTarget, DeploymentTrigger, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { encryptJson, encryptString, randomId } from "@/lib/crypto";
import { appendLog, endLogs, deleteLogs } from "@/lib/logs";
import { deploymentHost } from "@/lib/deployments";

const H = 3600_000;
const now = Date.now();
let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const sha = () => crypto.createHash("sha1").update(String(rnd())).digest("hex");

type ProjectSpec = {
  slug: string;
  name: string;
  framework: string;
  kind: "WEB" | "WORKER" | "STATIC" | "COMPOSE";
  repo: string;
  port: number;
  description: string;
  deployments: number;
  branches: string[];
  messages: string[];
  traffic: number; // avg requests / hour
};

const SPECS: ProjectSpec[] = [
  {
    slug: "levant-store",
    name: "levant-store",
    framework: "nextjs",
    kind: "WEB",
    repo: "levantlabs/levant-store",
    port: 3000,
    description: "Storefront (Next.js App Router)",
    deployments: 26,
    branches: ["feat/checkout-v2", "fix/cart-badge", "chore/deps", "feat/arabic-locale"],
    messages: [
      "feat(checkout): Apple Pay + mada support",
      "fix: cart badge count after hydration",
      "perf: stream product grid with Suspense",
      "chore(deps): bump next to 15.5",
      "feat(i18n): Arabic RTL layout for product pages",
      "fix(seo): canonical URLs for paginated categories",
      "refactor: move pricing to server actions",
      "feat: wishlist sync across devices",
    ],
    traffic: 4200,
  },
  {
    slug: "api-gateway",
    name: "api-gateway",
    framework: "express",
    kind: "WEB",
    repo: "levantlabs/api-gateway",
    port: 8080,
    description: "Public REST gateway (Express + Redis rate limiting)",
    deployments: 18,
    branches: ["feat/rate-limit-tiers", "fix/jwt-clock-skew"],
    messages: ["feat: per-tier rate limits", "fix: tolerate 30s JWT clock skew", "chore: structured logs (pino)", "feat: /v2/orders proxy", "fix: CORS for admin subdomain"],
    traffic: 9800,
  },
  {
    slug: "docs-site",
    name: "docs-site",
    framework: "astro",
    kind: "STATIC",
    repo: "levantlabs/docs",
    port: 80,
    description: "Documentation (Astro Starlight)",
    deployments: 14,
    branches: ["docs/cli-reference", "docs/domains-guide"],
    messages: ["docs: CLI reference for `levant env pull`", "docs: custom domains & DNS guide", "style: dark mode code blocks", "docs: rollback FAQ"],
    traffic: 1300,
  },
  {
    slug: "ml-inference",
    name: "ml-inference",
    framework: "fastapi",
    kind: "WEB",
    repo: "levantlabs/ml-inference",
    port: 8000,
    description: "FastAPI model server (CPU)",
    deployments: 11,
    branches: ["feat/batching", "exp/onnx-runtime"],
    messages: ["feat: dynamic request batching", "exp: ONNX runtime backend", "fix: warmup before healthcheck", "chore: pin torch 2.4"],
    traffic: 650,
  },
  {
    slug: "billing-worker",
    name: "billing-worker",
    framework: "go",
    kind: "WORKER",
    repo: "levantlabs/billing-worker",
    port: 8080,
    description: "Invoice + dunning queue consumer (Go)",
    deployments: 9,
    branches: ["fix/retry-backoff"],
    messages: ["fix: exponential retry backoff", "feat: dunning emails in Arabic", "chore: go 1.23"],
    traffic: 0,
  },
];

const USERS = [
  { email: "lina@levantdeploy.local", name: "Lina Haddad", role: "ADMIN" as const },
  { email: "omar@levantdeploy.local", name: "Omar Khalil", role: "MEMBER" as const },
];

function buildLog(spec: ProjectSpec, d: { number: number; branch: string; commitSha: string; status: DeploymentStatus; target: DeploymentTarget }) {
  const c = (n: number, s: string) => `\x1b[${n}m${s}\x1b[0m`;
  const lines = [
    `Deployment #${d.number} queued (${d.target.toLowerCase()})`,
    `${c(36, "▲")} Cloning github.com/${spec.repo} (Branch: ${d.branch}, Commit: ${d.commitSha.slice(0, 7)})`,
    `Cloning completed: 1.284s`,
    `${c(36, "▲")} Detected framework: ${c(1, spec.framework)}`,
    `Using generated Dockerfile (${spec.framework === "go" ? "golang:1.23-alpine" : spec.framework === "fastapi" ? "python:3.12-slim" : "node:22-alpine"})`,
    `#1 [internal] load build definition from Dockerfile`,
    `#2 [internal] load metadata`,
    `#3 [deps 1/4] ${spec.framework === "go" ? "RUN go mod download" : spec.framework === "fastapi" ? "RUN pip install -r requirements.txt" : "RUN npm ci"}`,
    `#3 CACHED`,
    `#4 [build 2/4] COPY . .`,
    `#5 [build 3/4] ${spec.framework === "go" ? "RUN go build -o /app ./cmd/worker" : spec.framework === "fastapi" ? "RUN python -m compileall ." : "RUN npm run build"}`,
  ];
  if (spec.framework === "nextjs") {
    lines.push(
      `#5 2.10   ▲ Next.js 15.5.2`,
      `#5 2.11   Creating an optimized production build ...`,
      `#5 18.42  ✓ Compiled successfully in 14.9s`,
      `#5 18.90  ✓ Linting and checking validity of types`,
      `#5 24.12  ✓ Generating static pages (42/42)`,
      `#5 24.80  Route (app)                    Size  First Load JS`,
      `#5 24.80  ┌ ○ /                          5.2 kB        118 kB`,
      `#5 24.80  ├ ƒ /products/[slug]           3.1 kB        116 kB`,
      `#5 24.80  └ ƒ /checkout                  8.9 kB        124 kB`,
    );
  }
  if (d.status === "ERROR") {
    lines.push(
      `#5 9.81 ${c(33, "warn")} deprecated punycode module`,
      `#5 12.02 ${c(31, "Error:")} Type error: Property 'currency' does not exist on type 'Price'.`,
      `#5 12.02   ${c(2, "src/lib/pricing.ts:48:19")}`,
      `${c(31, "ERROR")} failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1`,
      `${c(31, "Build failed")} after 42s`,
    );
    return lines;
  }
  if (d.status === "CANCELED") return [...lines, "Deployment canceled."];
  if (d.status === "BUILDING") return lines.slice(0, 9);
  if (d.status === "QUEUED") return lines.slice(0, 1);
  lines.push(
    `#6 exporting to image`,
    `#6 naming to docker.io/levant/${spec.slug}:${d.commitSha.slice(0, 12)} done`,
    `${c(32, "✓")} Build completed in 38s`,
    `${c(36, "▲")} Deploying 1 replica on levant_net (port ${spec.port})`,
    `Waiting for healthcheck GET / … ${c(32, "200 OK")} (1.9s)`,
    `${c(32, "✓")} Ready — routes updated`,
  );
  return lines;
}

async function main() {
  const admin = await db.user.findUnique({ where: { email: "admin@levantdeploy.local" } });
  if (!admin) throw new Error("Run `npm run db:seed` first");
  const team = await db.team.findFirst({ where: { slug: "admin" } });
  if (!team) throw new Error("team /admin missing");
  const r = redis();

  // members
  const users = [admin];
  for (const u of USERS) {
    const row = await db.user.upsert({
      where: { email: u.email },
      create: { email: u.email, name: u.name, passwordHash: await bcrypt.hash("Demo@12345", 10), emailVerifiedAt: new Date() },
      update: {},
    });
    await db.membership.upsert({ where: { teamId_userId: { teamId: team.id, userId: row.id } }, create: { teamId: team.id, userId: row.id, role: u.role }, update: { role: u.role } });
    users.push(row);
  }

  // wipe previous demo projects (cascades) + their logs
  const slugs = SPECS.map((s) => s.slug);
  const old = await db.deployment.findMany({ where: { project: { teamId: team.id, slug: { in: [...slugs, "demo-app"] } } }, select: { id: true } });
  for (const o of old) await deleteLogs(o.id);
  await db.project.deleteMany({ where: { teamId: team.id, slug: { in: slugs } } });
  await db.deployment.deleteMany({ where: { project: { teamId: team.id, slug: "demo-app" } } });
  await db.sharedEnvGroup.deleteMany({ where: { teamId: team.id } });
  await db.notification.deleteMany({ where: { teamId: team.id } });
  await db.userNotification.deleteMany({ where: { teamId: team.id } });
  await db.auditLog.deleteMany({ where: { teamId: team.id } }); // demo team only: start the activity feed clean

  const projects: { spec: ProjectSpec; id: string }[] = [];
  for (const spec of SPECS) {
    const p = await db.project.create({
      data: {
        teamId: team.id,
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        framework: spec.framework,
        kind: spec.kind,
        sourceType: "GITHUB",
        githubRepoFullName: spec.repo,
        gitUrl: `https://github.com/${spec.repo}.git`,
        productionBranch: "main",
        port: spec.port,
        healthcheckPath: spec.kind === "WORKER" ? null : "/",
        replicas: spec.slug === "api-gateway" ? 2 : 1,
        cpuLimit: spec.slug === "ml-inference" ? 2 : 1,
        memoryLimitMb: spec.slug === "ml-inference" ? 2048 : 512,
        buildSettings: spec.framework === "nextjs" ? { installCommand: "npm ci", buildCommand: "npm run build", startCommand: "npm start", nodeVersion: "22" } : {},
        protection: spec.slug === "levant-store" ? { mode: "password", scope: "previews", passwordHash: await bcrypt.hash("preview-demo", 10), updatedAt: new Date(now - 5 * 24 * H).toISOString() } : {},
        createdById: admin.id,
        createdAt: new Date(now - 40 * 24 * H),
      },
    });
    projects.push({ spec, id: p.id });
  }
  const demo = await db.project.findUnique({ where: { teamId_slug: { teamId: team.id, slug: "demo-app" } } });

  // deployments
  let logged = 0;
  for (const { spec, id } of projects) {
    let t = now - 14 * 24 * H;
    const step = (14 * 24 * H) / spec.deployments;
    let lastProdReady: string | null = null;
    for (let n = 1; n <= spec.deployments; n++) {
      t += step * (0.6 + rnd() * 0.8);
      if (t > now - 10 * 60_000) t = now - (spec.deployments - n + 1) * 7 * 60_000;
      if (n === spec.deployments && (spec.slug === "levant-store" || spec.slug === "ml-inference")) t = now - (spec.slug === "levant-store" ? 95_000 : 20_000);
      const isLast = n === spec.deployments;
      const isProd = rnd() < 0.45 || n % 5 === 0;
      const target: DeploymentTarget = isProd ? "PRODUCTION" : "PREVIEW";
      const branch = isProd ? "main" : pick(spec.branches);
      let status: DeploymentStatus = rnd() < 0.12 ? "ERROR" : rnd() < 0.05 ? "CANCELED" : "READY";
      if (spec.slug === "levant-store" && isLast) status = "BUILDING";
      if (spec.slug === "levant-store" && n === spec.deployments - 1) status = "READY";
      if (spec.slug === "api-gateway" && isLast) status = "ERROR";
      if (spec.slug === "ml-inference" && isLast) status = "QUEUED";
      const author = pick(users);
      const commitSha = sha();
      const sid = randomId(9);
      const created = new Date(t);
      const buildMs = 25_000 + Math.floor(rnd() * 70_000);
      const deployMs = 4_000 + Math.floor(rnd() * 9_000);
      const trigger: DeploymentTrigger = rnd() < 0.8 ? (target === "PREVIEW" ? "PULL_REQUEST" : "GIT_PUSH") : pick(["MANUAL", "CLI", "REDEPLOY"] as const);
      const ts = (ms: number) => new Date(t + ms);
      const finalReady = status === "READY";
      const events: Prisma.DeploymentEventCreateWithoutDeploymentInput[] = [{ status: "QUEUED", message: "Deployment queued", createdAt: created }];
      const data: Prisma.DeploymentUncheckedCreateInput = {
        projectId: id,
        number: n,
        shortId: sid,
        url: deploymentHost(spec.slug, sid),
        target,
        status,
        trigger,
        branch,
        commitSha,
        commitMessage: pick(spec.messages),
        commitAuthor: author.name,
        prNumber: target === "PREVIEW" ? 100 + n : null,
        framework: spec.framework,
        createdById: trigger === "MANUAL" || trigger === "REDEPLOY" || trigger === "CLI" ? author.id : null,
        createdAt: created,
        meta: {},
      };
      if (status !== "QUEUED") {
        data.buildStartedAt = ts(3_000);
        events.push({ fromStatus: "QUEUED", status: "BUILDING", createdAt: ts(3_000) });
      }
      if (status === "READY") {
        data.buildFinishedAt = ts(3_000 + buildMs);
        data.deployStartedAt = ts(3_000 + buildMs);
        data.readyAt = ts(3_000 + buildMs + deployMs);
        data.finishedAt = data.readyAt;
        data.duration = 3_000 + buildMs + deployMs;
        data.imageTag = `levant/${spec.slug}:${commitSha.slice(0, 12)}`;
        events.push({ fromStatus: "BUILDING", status: "DEPLOYING", createdAt: ts(3_000 + buildMs) }, { fromStatus: "DEPLOYING", status: "READY", createdAt: ts(3_000 + buildMs + deployMs) });
      } else if (status === "ERROR") {
        data.buildFinishedAt = ts(3_000 + 42_000);
        data.finishedAt = ts(3_000 + 42_000);
        data.duration = 45_000;
        data.errorStep = "BUILD";
        data.errorMessage = "Command \"npm run build\" exited with 1 — Type error: Property 'currency' does not exist on type 'Price'.";
        events.push({ fromStatus: "BUILDING", status: "ERROR", message: "Build failed: exit code 1", createdAt: ts(45_000) });
      } else if (status === "CANCELED") {
        data.finishedAt = ts(15_000);
        data.duration = 15_000;
        events.push({ fromStatus: "BUILDING", status: "CANCELED", message: "Canceled by user", createdAt: ts(15_000) });
      }
      const dep = await db.deployment.create({ data: { ...data, events: { create: events } } });
      if (finalReady && target === "PRODUCTION") {
        if (lastProdReady) {
          await db.deployment.update({ where: { id: lastProdReady }, data: { status: "SUPERSEDED", stoppedAt: ts(3_000 + buildMs + deployMs + 15_000) } });
          await db.deploymentEvent.create({ data: { deploymentId: lastProdReady, fromStatus: "READY", status: "SUPERSEDED", message: `Superseded by #${n}`, createdAt: ts(3_000 + buildMs + deployMs) } });
        }
        lastProdReady = dep.id;
      }
      // logs for the most recent deployments (+ all errors)
      if (n > spec.deployments - 6 || status === "ERROR") {
        await appendLog(dep.id, "BUILD", buildLog(spec, { number: n, branch, commitSha, status, target }));
        if (status !== "BUILDING" && status !== "QUEUED") await endLogs(dep.id, "BUILD");
        if (status === "READY") {
          await appendLog(dep.id, "RUNTIME", [`> ${spec.slug}@1.0.0 start`, `Listening on http://0.0.0.0:${spec.port}`, `GET / 200 12ms`, `GET /api/health 200 2ms`]);
        }
        logged++;
      }
    }
    if (lastProdReady) await db.deployment.update({ where: { id: lastProdReady }, data: { isCurrentProduction: true } });
    await db.project.update({ where: { id }, data: { lastDeployedAt: new Date(t) } });
  }

  // demo-app: a couple of deployments so it isn't empty
  if (demo) {
    for (let n = 1; n <= 3; n++) {
      const sid = randomId(9);
      const created = new Date(now - (4 - n) * 26 * H);
      await db.deployment.create({
        data: {
          projectId: demo.id,
          number: n,
          shortId: sid,
          url: deploymentHost(demo.slug, sid),
          target: "PRODUCTION",
          status: n === 3 ? "READY" : "SUPERSEDED",
          trigger: "MANUAL",
          branch: "main",
          commitSha: sha(),
          commitMessage: ["Initial commit", "Add hello page", "Update README"][n - 1],
          commitAuthor: "Admin",
          createdById: admin.id,
          isCurrentProduction: n === 3,
          createdAt: created,
          buildStartedAt: new Date(created.getTime() + 2000),
          buildFinishedAt: new Date(created.getTime() + 52000),
          readyAt: new Date(created.getTime() + 60000),
          finishedAt: new Date(created.getTime() + 60000),
          duration: 60000,
          events: { create: [{ status: "QUEUED", createdAt: created }, { status: "BUILDING", fromStatus: "QUEUED", createdAt: new Date(created.getTime() + 2000) }, { status: "DEPLOYING", fromStatus: "BUILDING", createdAt: new Date(created.getTime() + 52000) }, { status: "READY", fromStatus: "DEPLOYING", createdAt: new Date(created.getTime() + 60000) }] },
        },
      });
    }
  }

  const store = projects.find((p) => p.spec.slug === "levant-store")!.id;
  const api = projects.find((p) => p.spec.slug === "api-gateway")!.id;
  const ml = projects.find((p) => p.spec.slug === "ml-inference")!.id;

  // env vars
  const env = (projectId: string, key: string, value: string, o: { secret?: boolean; targets?: ("PRODUCTION" | "PREVIEW" | "DEVELOPMENT")[]; branch?: string; comment?: string; by?: string } = {}) =>
    db.envVar.create({
      data: {
        projectId,
        key,
        valueEnc: encryptString(value),
        isSecret: !!o.secret,
        targets: o.targets ?? ["PRODUCTION", "PREVIEW", "DEVELOPMENT"],
        branch: o.branch ?? null,
        comment: o.comment ?? null,
        createdById: o.by ?? admin.id,
        createdAt: new Date(now - 20 * 24 * H),
      },
    });
  await env(store, "NEXT_PUBLIC_API_URL", "https://api.levant.dev/v2");
  await env(store, "DATABASE_URL", "postgres://store:s3cr3t@ld-db-store:5432/store", { secret: true, targets: ["PRODUCTION"], comment: "Managed Postgres add-on" });
  await env(store, "DATABASE_URL", "postgres://store:preview@ld-db-store-preview:5432/store", { secret: true, targets: ["PREVIEW", "DEVELOPMENT"] });
  await env(store, "STRIPE_SECRET_KEY", "sk_live_demo_not_a_real_key_000000", { secret: true, targets: ["PRODUCTION"], by: users[1]!.id });
  await env(store, "STRIPE_SECRET_KEY", "sk_test_demo_not_a_real_key_000000", { secret: true, targets: ["PREVIEW", "DEVELOPMENT"], by: users[1]!.id });
  await env(store, "NEXT_PUBLIC_FEATURE_CHECKOUT_V2", "true", { targets: ["PREVIEW"], branch: "feat/checkout-v2", comment: "Only for the checkout-v2 previews" });
  await env(store, "REVALIDATE_SECONDS", "60");
  await env(store, "NODE_OPTIONS", "--max-old-space-size=384", { targets: ["PRODUCTION", "PREVIEW"] });
  await env(api, "REDIS_URL", "redis://ld-db-cache:6379/0", { secret: true });
  await env(api, "JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq…demo\n-----END PUBLIC KEY-----", { comment: "RS256 verification key" });
  await env(api, "RATE_LIMIT_RPM", "600");
  await env(ml, "MODEL_NAME", "levant-intent-v3");
  await env(ml, "HF_TOKEN", "hf_demo_not_a_real_token", { secret: true });
  // make the store look like it has a pending env change (banner)
  await db.envVar.updateMany({ where: { projectId: store, key: "REVALIDATE_SECONDS" }, data: { updatedAt: new Date(now - 30 * 60_000) } });

  const group = await db.sharedEnvGroup.create({
    data: {
      teamId: team.id,
      name: "observability",
      description: "Sentry + OpenTelemetry for every service",
      vars: {
        create: [
          { key: "SENTRY_DSN", valueEnc: encryptString("https://public@sentry.levant.dev/4"), isSecret: false, createdById: admin.id },
          { key: "OTEL_EXPORTER_OTLP_ENDPOINT", valueEnc: encryptString("http://otel-collector:4318"), createdById: admin.id },
          { key: "OTEL_EXPORTER_OTLP_HEADERS", valueEnc: encryptString("x-api-key=demo-not-real"), isSecret: true, createdById: admin.id },
        ],
      },
    },
  });
  await db.sharedEnvGroup.create({
    data: { teamId: team.id, name: "payments", description: "Payment provider keys", vars: { create: [{ key: "TAP_SECRET_KEY", valueEnc: encryptString("tap_demo_000"), isSecret: true, targets: ["PRODUCTION"], createdById: admin.id }] } },
  });
  await db.projectSharedEnvGroup.createMany({ data: [{ projectId: store, groupId: group.id }, { projectId: api, groupId: group.id }] });

  // domains
  const dom = (projectId: string, hostname: string, o: Partial<Prisma.DomainUncheckedCreateInput> = {}) =>
    db.domain.create({ data: { projectId, hostname, kind: "CUSTOM", status: "ACTIVE", verifyToken: randomId(24), verifiedAt: new Date(now - 30 * 24 * H), certStatus: "ISSUED", ...o } });
  await dom(store, "shop.levant.dev", { isPrimary: true });
  await dom(store, "www.shop.levant.dev", { redirectTo: "shop.levant.dev", redirectStatus: 308 });
  await dom(store, "staging.shop.levant.dev", { gitBranch: "feat/checkout-v2" });
  await dom(api, "api.levant.dev", { isPrimary: true });
  await dom(projects.find((p) => p.spec.slug === "docs-site")!.id, "docs.levant.dev", { isPrimary: true });
  await dom(ml, "ml.levant.dev", { status: "VERIFYING", verifiedAt: null, certStatus: "PENDING" });

  // metrics: hourly buckets for 30 days
  await db.metricSample.deleteMany({ where: { projectId: { in: projects.map((p) => p.id) } } });
  const rows: Prisma.MetricSampleCreateManyInput[] = [];
  for (const { spec, id } of projects) {
    if (!spec.traffic) continue;
    for (let h = 30 * 24; h >= 1; h--) {
      const bucket = new Date(Math.floor((now - h * H) / H) * H);
      const hour = bucket.getUTCHours();
      const diurnal = 0.45 + 0.55 * Math.sin(((hour - 6) / 24) * Math.PI * 2) ** 2;
      const trend = 0.8 + ((30 * 24 - h) / (30 * 24)) * 0.4;
      const req = Math.round(spec.traffic * diurnal * trend * (0.8 + rnd() * 0.4));
      rows.push({
        projectId: id,
        bucket,
        requests: req,
        errors: Math.round(req * (spec.slug === "api-gateway" ? 0.012 : 0.003) * rnd() * 2),
        cpuPercent: 4 + rnd() * 30 * diurnal,
        memoryBytes: (180 + rnd() * 120) * 1024 * 1024,
        memoryLimitBytes: 512 * 1024 * 1024,
        netTxBytes: req * (spec.framework === "astro" ? 42_000 : 18_000) * (0.8 + rnd() * 0.4),
        netRxBytes: req * 1_400,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 2000) await db.metricSample.createMany({ data: rows.slice(i, i + 2000) });

  // notification channels
  await db.notification.createMany({
    data: [
      { teamId: team.id, type: "EMAIL", name: "Team inbox", configEnc: encryptJson({ to: ["ops@levant.dev"] }), events: ["deployment.error"], lastSentAt: new Date(now - 3 * H) },
      { teamId: team.id, type: "SLACK", name: "#deployments", configEnc: encryptJson({ webhookUrl: "https://hooks.slack.com/services/T000/B000/demo" }), events: ["deployment.ready", "deployment.error"], lastSentAt: new Date(now - 40 * 60_000) },
      { teamId: team.id, type: "WEBHOOK", name: "Status page", configEnc: encryptJson({ url: "https://status.levant.dev/hooks/levant", secret: "whsec_demo_000000" }), events: ["deployment.ready", "deployment.error"], lastError: "HTTP 502: Bad Gateway", lastSentAt: new Date(now - 2 * H) },
      { teamId: team.id, projectId: store, type: "TELEGRAM", name: "Store on-call", configEnc: encryptJson({ botToken: "123456:ABCdemoTokenNotReal_000000", chatId: "-1001234567" }), events: ["deployment.error"], enabled: false },
    ],
  });

  // in-app notifications (latest deployments)
  const recent = await db.deployment.findMany({ where: { project: { teamId: team.id }, status: { in: ["READY", "ERROR"] } }, orderBy: { createdAt: "desc" }, take: 8, include: { project: true } });
  for (const [i, d] of recent.entries()) {
    const ok = d.status === "READY";
    await db.userNotification.create({
      data: {
        userId: admin.id,
        teamId: team.id,
        projectId: d.projectId,
        deploymentId: d.id,
        kind: ok ? "deployment.ready" : "deployment.error",
        title: `${d.project.name}: ${d.target === "PRODUCTION" ? "Production" : "Preview"} deployment #${d.number} ${ok ? "is ready" : "failed"}`,
        body: ok ? d.commitMessage : d.errorMessage,
        href: `/${team.slug}/${d.project.slug}/deployments/${d.id}`,
        dedupeKey: `demo:${d.id}`,
        readAt: i > 2 ? new Date() : null,
        createdAt: d.finishedAt ?? d.createdAt,
      },
    });
  }

  // a few audit entries for the activity feed
  await db.auditLog.createMany({
    data: [
      { teamId: team.id, userId: users[1]!.id, action: "env.create", targetType: "project", targetId: store, meta: { keys: ["STRIPE_SECRET_KEY"] }, createdAt: new Date(now - 26 * H) },
      { teamId: team.id, userId: admin.id, action: "domain.add", targetType: "domain", targetId: ml, meta: { hostname: "ml.levant.dev" }, createdAt: new Date(now - 50 * H) },
      { teamId: team.id, userId: users[1]!.id, action: "member.role_change", targetType: "user", targetId: users[2]!.id, meta: { role: "MEMBER", name: users[2]!.name }, createdAt: new Date(now - 72 * H) },
      { teamId: team.id, userId: admin.id, action: "project.update", targetType: "project", targetId: store, meta: { fields: ["protection"] }, createdAt: new Date(now - 5 * 24 * H) },
    ],
  });

  const count = await db.deployment.count({ where: { project: { teamId: team.id } } });
  console.log(`Demo data: ${projects.length + (demo ? 1 : 0)} projects, ${count} deployments (${logged} with logs), ${rows.length} metric samples → http://localhost:${process.env.PORT ?? 3000}/${team.slug}`);
  await r.quit();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
