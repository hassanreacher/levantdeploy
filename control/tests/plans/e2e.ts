/**
 * plans area end-to-end test against a running isolated instance (default http://localhost:3109).
 *   1. DB: createdb levantdeploy_plans; DATABASE_URL=… npx prisma db push && npm run db:seed
 *   2. app: `set -a; . ./.env.plans; set +a; npx next dev -p 3109 > $LOG 2>&1` (no SMTP → verification mails are logged)
 *   3. `set -a; . ./.env.plans; set +a; E2E_DEV_LOG=$LOG npx tsx tests/plans/e2e.ts`
 * Covers: open registration (terms checkbox, disposable-email blocklist), unverified user blocked (403 EMAIL_UNVERIFIED),
 * verification through the logged link, project limit (402 PLAN_LIMIT on the next one), deployments/day limit with a
 * lowered test plan, members / upload / custom-domain limits, quota alerts (80 % / 100 %) → in-app notifications,
 * upgrade request → platform owner, owner assigns a bigger plan → limits lifted.
 * No worker is needed (alerts are dispatched in-process; build jobs stay queued in the isolated Redis db).
 */
import fs from "node:fs";
import { db } from "@/lib/db";
import { checkQuotas, dispatchPlanEvent, HOBBY_LIMITS } from "@/lib/plans";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3109";
const LOG = process.env.E2E_DEV_LOG || "";
const stamp = Date.now().toString(36);
let passed = 0;

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${msg}`);
}

class Client {
  cookies = new Map<string, string>();
  async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        origin: BASE,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      this.cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data: data as T };
  }
  post = <T = Record<string, unknown>>(p: string, b: unknown = {}) => this.req<T>("POST", p, b);
  get = <T = Record<string, unknown>>(p: string) => this.req<T>("GET", p);
  patch = <T = Record<string, unknown>>(p: string, b: unknown) => this.req<T>("PATCH", p, b);
}

type Err = { error: { code: string; message: string; resource?: string; limit?: number; used?: number; upgradeUrl?: string; fields?: Record<string, string> } };

async function verificationLink(email: string): Promise<string> {
  ok(LOG && fs.existsSync(LOG), "dev server log available (E2E_DEV_LOG)");
  for (let i = 0; i < 40; i++) {
    const text = fs.readFileSync(LOG, "utf8");
    const idx = text.lastIndexOf(`[mail:dev] to=${email}`);
    if (idx >= 0) {
      const m = text.slice(idx).match(/https?:\/\/\S+\/verify-email\?token=([A-Za-z0-9_-]+)/);
      if (m) return m[1]!;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no verification email for ${email} in ${LOG}`);
}

async function main() {
  // ── owner ──
  const owner = new Client();
  const login = await owner.post("/api/v1/auth/login", { email: "admin@levantdeploy.local", password: "Admin@12345" });
  ok(login.status === 200, "platform owner signs in");
  const pol = await owner.patch<{ policy: { registration: string } }>("/api/v1/platform/signups", {
    registration: "open",
    requireEmailVerification: true,
    blockDisposableEmails: true,
    requireTerms: true,
    signupRateLimit: { limit: 50, windowMinutes: 60 },
  });
  ok(pol.status === 200 && pol.data.policy.registration === "open", "registration is open (owner sign-up settings)");
  const ownerPlan = await owner.get<{ plan: { slug: string } }>("/api/v1/teams/admin/plan");
  ok(ownerPlan.data.plan.slug === "unlimited", "platform owner's team resolves to the internal unlimited plan");

  // ── registration ──
  const user = new Client();
  const email = `e2e-plans-${stamp}@example.com`;
  const noTerms = await user.post<Err>("/api/v1/auth/register", { name: "Plan Tester", email, password: "Passw0rd!x" });
  ok(noTerms.status === 422 && !!noTerms.data.error.fields?.acceptTerms, "sign-up without accepting the terms → 422");
  const disp = await user.post<Err>("/api/v1/auth/register", { name: "Spam", email: `x${stamp}@mailinator.com`, password: "Passw0rd!x", acceptTerms: true });
  ok(disp.status === 422 && !!disp.data.error.fields?.email, "disposable email domain → 422");
  const reg = await user.post<{ user: { emailVerified: boolean }; redirect: string }>("/api/v1/auth/register", { name: "Plan Tester", email, password: "Passw0rd!x", acceptTerms: true });
  ok(reg.status === 201 && reg.data.user.emailVerified === false, "fresh user registers (open registration), unverified");
  const team = reg.data.redirect.slice(1);
  const tplan = await user.get<{ plan: { slug: string } }>(`/api/v1/teams/${team}/plan`);
  ok(tplan.data.plan.slug === "hobby", `new personal team /${team} is on the default Hobby plan`);

  const blocked = await user.post<Err>("/api/v1/projects", { team, name: "early", source: { type: "none" } });
  ok(blocked.status === 403 && blocked.data.error.code === "EMAIL_UNVERIFIED", "unverified user can't create a project → 403 EMAIL_UNVERIFIED");
  const resend = await user.post("/api/v1/auth/verify-email/resend");
  ok(resend.status === 200, "resend verification email");

  const token = await verificationLink(email);
  const bad = await user.post<Err>("/api/v1/auth/verify-email", { token: "x".repeat(32) });
  ok(bad.status === 400, "invalid verification token → 400");
  const ver = await new Client().post<{ ok: boolean }>("/api/v1/auth/verify-email", { token });
  ok(ver.status === 200 && ver.data.ok, "email verified through the logged link (signed out)");

  // Hobby members = owner only
  const inv = await user.post<Err>(`/api/v1/teams/${team}/invites`, { email: `friend-${stamp}@example.com`, role: "MEMBER" });
  ok(inv.status === 402 && inv.data.error.code === "PLAN_LIMIT" && inv.data.error.resource === "deploy.members", "Hobby: inviting a member → 402 PLAN_LIMIT (members)");

  // ── lowered test plan ──
  await owner.req("DELETE", `/api/v1/platform/plans/e2e-tiny`);
  const tiny = await owner.post<{ plan: { id: string } }>("/api/v1/platform/plans", {
    slug: "e2e-tiny",
    name: "E2E Tiny",
    priceMonthly: 0,
    limits: { ...HOBBY_LIMITS, deploy: { ...HOBBY_LIMITS.deploy, projects: 2, deploymentsPerDay: 3, domainsPerProject: 1, uploadMb: 1 } },
  });
  ok(tiny.status === 201, "owner creates a lowered test plan (2 projects, 3 deployments/day)");
  const as = await owner.post<{ plan: { slug: string } }>("/api/v1/platform/plans/assign", { team, plan: "e2e-tiny" });
  ok(as.status === 200 && as.data.plan.slug === "e2e-tiny", "owner assigns the test plan to the user's team");

  const p1 = await user.post<{ project: { id: string }; deployment: { id: string } | null }>("/api/v1/projects", { team, name: `img-${stamp}`, source: { type: "image", image: "nginx:alpine" } });
  ok(p1.status === 201 && !!p1.data.deployment, "project 1 (image) created with its first deployment");
  const p2 = await user.post("/api/v1/projects", { team, name: `empty-${stamp}`, source: { type: "none" } });
  ok(p2.status === 201, "project 2 created (at the limit)");
  const p3 = await user.post<Err>("/api/v1/projects", { team, name: `third-${stamp}`, source: { type: "none" } });
  ok(
    p3.status === 402 && p3.data.error.code === "PLAN_LIMIT" && p3.data.error.resource === "deploy.projects" && p3.data.error.limit === 2 && p3.data.error.used === 2,
    "project 3 → 402 {code: PLAN_LIMIT, resource: deploy.projects, limit: 2, used: 2}",
  );
  ok(p3.data.error.upgradeUrl === `/${team}/settings/plan`, "error links to Settings → Plan & Usage");

  const pid = p1.data.project.id;
  const d2 = await user.post(`/api/v1/projects/${pid}/deployments`, { target: "PRODUCTION" });
  const d3 = await user.post(`/api/v1/projects/${pid}/deployments`, { target: "PRODUCTION" });
  ok(d2.status === 201 && d3.status === 201, "deployments 2 and 3 of the day created");
  const d4 = await user.post<Err>(`/api/v1/projects/${pid}/deployments`, { target: "PRODUCTION" });
  ok(d4.status === 402 && d4.data.error.resource === "deploy.deploymentsPerDay" && d4.data.error.limit === 3, "deployment 4 → 402 PLAN_LIMIT (deploymentsPerDay 3)");

  const up = await user.post<Err>("/api/v1/uploads", { team, size: 2 * 1024 * 1024 });
  ok(up.status === 402 && up.data.error.resource === "deploy.uploadMb", "2 MB upload on a 1 MB plan → 402 PLAN_LIMIT (uploadMb)");
  const dom1 = await user.post(`/api/v1/projects/${pid}/domains`, { hostname: `app-${stamp}.example.com` });
  ok(dom1.status === 201, "custom domain 1 added");
  const dom2 = await user.post<Err>(`/api/v1/projects/${pid}/domains`, { hostname: `www2-${stamp}.example.com` });
  ok(dom2.status === 402 && dom2.data.error.resource === "deploy.domainsPerProject", "custom domain 2 → 402 PLAN_LIMIT (domainsPerProject 1)");

  // ── usage + alerts ──
  const usage = await user.get<{ usage: { deploy: { resource: string; used: number; limit: number | null }[]; overQuota: { resource: string }[] } }>(`/api/v1/teams/${team}/plan`);
  const byRes = Object.fromEntries(usage.data.usage.deploy.map((i) => [i.resource, i]));
  ok(byRes["deploy.projects"]?.used === 2 && byRes["deploy.deploymentsPerDay"]?.used === 3, "Plan & Usage API reports 2/2 projects, 3/3 deployments today");
  const teamRow = await db.team.findUniqueOrThrow({ where: { slug: team } });
  const q = await checkQuotas(teamRow.id, { enqueue: false });
  ok(q.sent.some((s) => s.resource === "deploy.projects" && s.level === 100), "quota check emits a 100 % alert for projects");
  for (const s of q.sent) await dispatchPlanEvent(s.level === 100 ? "plan.quota_exceeded" : "plan.quota_warning", { teamId: teamRow.id, payload: s as unknown as Record<string, unknown> });
  const again = await checkQuotas(teamRow.id, { enqueue: false });
  ok(again.sent.length === 0, "alerts are deduplicated per period");
  const notes = await user.get<{ items: { kind: string; title: string }[] }>("/api/v1/me/notifications");
  ok(notes.data.items?.some((n) => n.kind === "plan.quota_exceeded"), "owner of the team got an in-app quota notification");

  const ureq = await user.post<{ request: { id: string } }>(`/api/v1/teams/${team}/plan/upgrade-request`, { plan: "pro", message: "need more projects" });
  ok(ureq.status === 201, "user requests an upgrade to Pro");
  await dispatchPlanEvent("plan.upgrade_request", { teamId: teamRow.id, payload: { requestId: ureq.data.request.id, plan: "Pro", by: "Plan Tester" } });
  const adm = await owner.get<{ requests: { id: string }[] }>("/api/v1/platform/plans");
  ok(adm.data.requests.some((r) => r.id === ureq.data.request.id), "owner sees the open upgrade request on /settings/plans");
  const over = await owner.get<{ items: { slug: string; overQuota: unknown[] }[] }>("/api/v1/platform/plans/teams?overQuota=1");
  ok(over.data.items.some((t) => t.slug === team), "owner sees the team in the over-quota list");

  // ── owner lifts the limit ──
  const pro = await owner.post<{ plan: { slug: string } }>("/api/v1/platform/plans/assign", { team, plan: "pro" });
  ok(pro.status === 200 && pro.data.plan.slug === "pro", "owner assigns Pro");
  const p3b = await user.post("/api/v1/projects", { team, name: `third-${stamp}`, source: { type: "none" } });
  ok(p3b.status === 201, "project 3 now succeeds (limit lifted)");
  const d4b = await user.post(`/api/v1/projects/${pid}/deployments`, { target: "PRODUCTION" });
  ok(d4b.status === 201, "deployment 4 now succeeds (6000/day on Pro)");
  const reqAfter = await db.planUpgradeRequest.findUnique({ where: { id: ureq.data.request.id } });
  ok(reqAfter?.status === "APPROVED", "assigning the plan closes the upgrade request");

  // keep the tiny plan for screenshots; restore the team to automatic in a separate run if needed
  console.log(`\n${passed} checks passed — team /${team} (${email})`);
  await db.$disconnect();
  process.exit(0); // the settings cache keeps a Redis connection open
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
