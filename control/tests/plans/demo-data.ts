/**
 * plans area: demo data for screenshots (isolated DB only). Adds the admin as ADMIN of the newest e2e team, puts the team
 * on Hobby, attaches a backend with usage near / over the limits, a standalone backend and a month of egress samples.
 *   set -a; . ./.env.plans; set +a; npx tsx tests/plans/demo-data.ts
 */
import { db } from "@/lib/db";
import { randomId } from "@/lib/crypto";
import { GB, MB } from "@/lib/plans/usage";

async function main() {
  const team = await db.team.findFirstOrThrow({ where: { slug: { startsWith: "e2e-plans-" } }, orderBy: { createdAt: "desc" }, include: { projects: true } });
  const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@levantdeploy.local" } });
  await db.membership.upsert({ where: { teamId_userId: { teamId: team.id, userId: admin.id } }, create: { teamId: team.id, userId: admin.id, role: "ADMIN" }, update: { role: "ADMIN" } });
  await db.team.update({ where: { id: team.id }, data: { name: "Acme Studio", planId: (await db.plan.findUniqueOrThrow({ where: { slug: "hobby" } })).id } });
  const app = team.projects.find((p) => p.slug.startsWith("img-")) ?? team.projects[0]!;
  await db.baseProject.deleteMany({ where: { teamId: team.id } });
  const mk = (name: string, projectId: string | null, status: "ACTIVE" | "PAUSED") =>
    db.baseProject.create({ data: { teamId: team.id, projectId, ref: randomId(20).toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 20), name, status, secretsEnc: "demo" } });
  const b1 = await mk(`${app.name}-db`, app.id, "ACTIVE");
  const b2 = await mk("analytics", null, "PAUSED");
  for (let i = 0; i < 3; i++) await db.baseFunction.create({ data: { baseProjectId: b1.id, name: `fn-${i}`, slug: `fn-${i}`, sourcePath: `volumes/functions/fn-${i}/index.ts` } });
  const now = Date.now();
  await db.baseUsageSample.createMany({
    data: [
      { baseProjectId: b1.id, at: new Date(now - 3600_000), dbSizeBytes: BigInt(Math.round(412 * MB)), storageSizeBytes: BigInt(Math.round(1.08 * GB)), mau: 12_840, requests: 51_000, functionInvocations: 182_000, egressBytes: BigInt(Math.round(2.1 * GB)) },
      { baseProjectId: b1.id, at: new Date(now - 60_000), dbSizeBytes: BigInt(Math.round(431 * MB)), storageSizeBytes: BigInt(Math.round(1.12 * GB)), mau: 13_102, requests: 3_000, functionInvocations: 9_400, egressBytes: BigInt(Math.round(0.4 * GB)) },
      { baseProjectId: b2.id, at: new Date(now - 7200_000), dbSizeBytes: BigInt(Math.round(64 * MB)), storageSizeBytes: BigInt(Math.round(120 * MB)), mau: 310, requests: 1_200, functionInvocations: 0, egressBytes: BigInt(Math.round(0.2 * GB)) },
    ],
  });
  // bandwidth: one container sample with 83 GB egress this month (rolled up into UsageCounter on the next read)
  await db.usageCounter.deleteMany({ where: { teamId: team.id } });
  await db.metricSample.create({ data: { kind: "container", projectId: app.id, bucket: new Date(Math.floor((now - 3 * 3600_000) / 60_000) * 60_000), netTxBytes: 83 * GB } });
  await db.domain.deleteMany({ where: { projectId: app.id, kind: "CUSTOM" } });
  await db.domain.create({ data: { projectId: app.id, hostname: `shop-${team.slug}.example.com`, kind: "CUSTOM", status: "ACTIVE", verifyToken: "demo" } });
  console.log(`demo data → /${team.slug}/settings/plan`);
  await db.$disconnect();
  process.exit(0);
}
main();
