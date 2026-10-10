/**
 * Demo data for the LevantBase dashboard (UI development / screenshots) — rows only, no Docker stacks.
 *   DATABASE_URL=… npx tsx scripts/seed-base-demo.ts          (after `npm run db:seed`)
 *   DATABASE_URL=… npx tsx scripts/seed-base-demo.ts --clean  (remove the demo rows again)
 * Idempotent. Fixed refs (demo…) so screenshots are stable. Also creates viewer@/member@levantdeploy.local (Admin@12345).
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { encryptSecrets, generateSecrets } from "../src/lib/base/secrets";
import fs from "node:fs";
import path from "node:path";
import { encryptString } from "../src/lib/crypto";
import { functionsDir } from "../src/lib/base/config";
import { FUNCTION_TEMPLATES } from "../src/lib/base-ui/shared";

const db = new PrismaClient();
const DAY = 86400_000;
const MB = 1024 * 1024;

const DEMO = [
  { ref: "demoacmebackendaaaaa", name: "acme-backend", status: "ACTIVE", attach: "demo-app", ageDays: 24 },
  { ref: "demomobileapibbbbbbb", name: "mobile-api", status: "ACTIVE", attach: null, ageDays: 9 },
  { ref: "demoanalyticsccccccc", name: "analytics", status: "PAUSED", attach: null, ageDays: 40 },
  { ref: "demonewbackenddddddd", name: "new-backend", status: "PROVISIONING", attach: null, ageDays: 0 },
] as const;

async function main() {
  const owner = await db.user.findUniqueOrThrow({ where: { email: "admin@levantdeploy.local" } });
  const team = await db.team.findFirstOrThrow({ where: { slug: "admin" } });
  if (process.argv.includes("--clean")) {
    await db.baseProject.deleteMany({ where: { ref: { in: DEMO.map((d) => d.ref) } } });
    console.log("Removed demo Base projects");
    return;
  }
  // extra users for permission checks
  const pw = await bcrypt.hash("Admin@12345", 10);
  for (const [email, role] of [
    ["viewer@levantdeploy.local", "VIEWER"],
    ["member@levantdeploy.local", "MEMBER"],
  ] as const) {
    const u = await db.user.upsert({ where: { email }, create: { email, name: role === "VIEWER" ? "Vera Viewer" : "Max Member", passwordHash: pw, emailVerifiedAt: new Date() }, update: {} });
    await db.membership.upsert({ where: { teamId_userId: { teamId: team.id, userId: u.id } }, create: { teamId: team.id, userId: u.id, role }, update: { role } });
  }

  // a Deploy project without a backend (Backend tab → "Add a backend")
  await db.project.upsert({ where: { teamId_slug: { teamId: team.id, slug: "landing-page" } }, create: { teamId: team.id, name: "landing-page", slug: "landing-page", framework: "nextjs" }, update: {} });

  for (const d of DEMO) {
    const project = d.attach ? await db.project.findFirst({ where: { teamId: team.id, slug: d.attach } }) : null;
    const createdAt = new Date(Date.now() - d.ageDays * DAY - 3600_000);
    const settings: Prisma.InputJsonObject = {
      auth: { siteUrl: "https://acme.example.com", additionalRedirectUrls: ["http://localhost:3000/**", "https://*.acme.example.com/**"], emailAutoconfirm: false },
      smtp: d.name === "acme-backend" ? { host: "smtp.example.com", port: 587, user: "apikey", passEnc: encryptString("demo-smtp-pass"), adminEmail: "no-reply@acme.example.com", senderName: "Acme" } : {},
      providers: d.name === "acme-backend" ? { google: { enabled: true, clientId: "1234567890-demo.apps.googleusercontent.com", secretEnc: encryptString("demo") }, github: { enabled: false, clientId: "Iv1.demo" } } : {},
      functions: { verifyJwt: true, secretsEnc: encryptString(JSON.stringify({ STRIPE_SECRET_KEY: "sk_test_demo", WEBHOOK_SECRET: "whsec_demo" })) },
      templates: { confirmation: { subject: "Confirm your Acme account", body: '<h2>Welcome to Acme</h2><p><a href="{{ .ConfirmationURL }}">Confirm your email</a></p>' } },
    };
    const versions = { db: "supabase/postgres:17.6.1.136", auth: "supabase/gotrue:v2.186.0", rest: "postgrest/postgrest:v14.5", realtime: "supabase/realtime:v2.76.5", storage: "supabase/storage-api:v1.37.8", functions: "supabase/edge-runtime:v1.70.3", meta: "supabase/postgres-meta:v0.95.2" };
    const row = await db.baseProject.upsert({
      where: { ref: d.ref },
      create: {
        ref: d.ref,
        name: d.name,
        teamId: team.id,
        projectId: project?.id ?? null,
        status: d.status,
        secretsEnc: encryptSecrets(await generateSecrets(d.ref, { dbPassword: "DemoPassw0rdForScreens123" })),
        versions: d.status === "PROVISIONING" ? {} : versions,
        settings,
        createdById: owner.id,
        createdAt,
        lastActivityAt: d.status === "ACTIVE" ? new Date(Date.now() - 5 * 60_000) : null,
        pausedAt: d.status === "PAUSED" ? new Date(Date.now() - 2 * DAY) : null,
      },
      update: { name: d.name, status: d.status, projectId: project?.id ?? null, settings },
    });
    await db.baseEvent.deleteMany({ where: { baseProjectId: row.id } });
    const ev = (minsAfter: number, type: string, level: string, message: string) => ({ baseProjectId: row.id, type, level, message, actorId: owner.id, createdAt: new Date(createdAt.getTime() + minsAfter * 60_000) });
    const events =
      d.status === "PROVISIONING"
        ? [ev(0, "provision", "info", "Provisioning queued"), ev(0.1, "provision", "info", "Generated secrets and rendered the stack configuration"), ev(0.3, "provision", "info", "Pulling images (7 of 11)")]
        : [
            ev(0, "provision", "info", "Provisioning queued"),
            ev(0.1, "provision", "info", "Generated secrets and rendered the stack configuration"),
            ev(0.5, "provision", "info", "Started 10 services"),
            ev(1.2, "provision", "info", "Database initialised"),
            ev(1.4, "provision", "success", "Project is ready"),
            ev(60 * 24 * 2, "functions", "info", "Deployed function hello-world (v1)"),
            ev(60 * 24 * 3, "settings", "info", "Settings applied (auth)"),
            ev(60 * 24 * 5, "backup", "success", "Backup finished (4.2 MB)"),
            ...(d.status === "PAUSED" ? [ev(60 * 24 * (d.ageDays - 2), "pause", "info", "Paused after 7 days without API requests")] : []),
          ];
    await db.baseEvent.createMany({ data: events });
    // usage samples (hourly → one per 6h for 30 days)
    await db.baseUsageSample.deleteMany({ where: { baseProjectId: row.id } });
    if (d.status !== "PROVISIONING") {
      const samples: Prisma.BaseUsageSampleCreateManyInput[] = [];
      const days = Math.min(30, d.ageDays);
      for (let i = days * 4; i >= 0; i--) {
        const t = Date.now() - i * 6 * 3600_000;
        const growth = 1 - i / (days * 4 + 1);
        samples.push({
          baseProjectId: row.id,
          at: new Date(t),
          dbSizeBytes: BigInt(Math.round((d.name === "acme-backend" ? 180 : 42) * MB * (0.4 + growth * 0.6))),
          storageSizeBytes: BigInt(Math.round((d.name === "acme-backend" ? 320 : 12) * MB * (0.3 + growth * 0.7))),
          mau: Math.round((d.name === "acme-backend" ? 3120 : 140) * (0.5 + growth * 0.5)),
          requests: 400 + ((i * 37) % 300),
          functionInvocations: d.name === "acme-backend" ? 900 + ((i * 53) % 700) : 20,
          egressBytes: BigInt(Math.round((d.name === "acme-backend" ? 9 : 1) * MB * (1 + ((i * 7) % 5) / 5))),
        });
      }
      await db.baseUsageSample.createMany({ data: samples });
    }
    // functions
    await db.baseFunction.deleteMany({ where: { baseProjectId: row.id } });
    if (d.status !== "PROVISIONING") {
      const fns = d.name === "acme-backend" ? ["hello-world", "stripe-webhook", "send-digest"] : d.name === "mobile-api" ? ["push-notify"] : [];
      for (const [i, slug] of fns.entries()) {
        const dir = path.join(functionsDir(d.ref), slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.ts"), (FUNCTION_TEMPLATES[i % FUNCTION_TEMPLATES.length] ?? FUNCTION_TEMPLATES[0]!).code);
        await db.baseFunction.create({
          data: { baseProjectId: row.id, slug, name: slug, verifyJwt: slug !== "stripe-webhook", sourcePath: `volumes/functions/${slug}/index.ts`, version: 3 - i, deployedAt: new Date(Date.now() - (i + 1) * DAY), createdAt: new Date(createdAt.getTime() + DAY) },
        });
      }
    }
    // backups
    await db.baseBackup.deleteMany({ where: { baseProjectId: row.id } });
    if (d.name === "acme-backend") {
      await db.baseBackup.createMany({
        data: [
          { baseProjectId: row.id, kind: "MANUAL", status: "SUCCEEDED", sizeBytes: BigInt(4_400_000), createdById: owner.id, createdAt: new Date(Date.now() - 2 * DAY), finishedAt: new Date(Date.now() - 2 * DAY + 20_000), path: `base/${d.ref}/backups/demo.sql.gz` },
          { baseProjectId: row.id, kind: "SCHEDULED", status: "SUCCEEDED", sizeBytes: BigInt(4_100_000), createdAt: new Date(Date.now() - 5 * DAY), finishedAt: new Date(Date.now() - 5 * DAY + 18_000), path: `base/${d.ref}/backups/demo2.sql.gz` },
          { baseProjectId: row.id, kind: "MANUAL", status: "FAILED", error: "pg_dump: connection refused", createdById: owner.id, createdAt: new Date(Date.now() - 8 * DAY), finishedAt: new Date(Date.now() - 8 * DAY + 3000) },
        ],
      });
    }
  }
  console.log(`Seeded ${DEMO.length} demo Base projects in team /${team.slug} (+ viewer@ / member@levantdeploy.local, password Admin@12345)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
