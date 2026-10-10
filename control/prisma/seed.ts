/**
 * Dev seed (idempotent): `npm run db:seed`
 *  - admin@levantdeploy.local / Admin@12345 (platform owner)
 *  - team "Personal" (slug "admin") with the admin as OWNER
 *  - demo project "demo-app" (no deployments)
 *  - local Server row
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ensureDefaultPlans } from "../src/lib/plans/plans";

const db = new PrismaClient();

async function main() {
  const email = "admin@levantdeploy.local";
  const passwordHash = await bcrypt.hash("Admin@12345", 12);
  const user = await db.user.upsert({
    where: { email },
    create: { email, name: "Admin", passwordHash, isPlatformOwner: true, emailVerifiedAt: new Date() },
    update: { passwordHash, isPlatformOwner: true },
  });

  let team = await db.team.findFirst({ where: { isPersonal: true, memberships: { some: { userId: user.id, role: "OWNER" } } } });
  if (!team) {
    team = await db.team.create({
      data: { name: "Personal", slug: "admin", isPersonal: true, memberships: { create: { userId: user.id, role: "OWNER" } } },
    });
  }

  await db.project.upsert({
    where: { teamId_slug: { teamId: team.id, slug: "demo-app" } },
    create: {
      teamId: team.id,
      name: "demo-app",
      slug: "demo-app",
      description: "Demo project created by the seed script",
      framework: "nextjs",
      kind: "WEB",
      sourceType: "GIT",
      gitUrl: "https://github.com/vercel/next.js.git",
      productionBranch: "main",
      rootDirectory: "examples/hello-world",
      buildSettings: { installCommand: "npm install", buildCommand: "npm run build", startCommand: "npm start", nodeVersion: "22" },
      port: 3000,
      healthcheckPath: "/",
      createdById: user.id,
    },
    update: {},
  });

  if (!(await db.server.findFirst({ where: { isLocal: true } }))) {
    await db.server.create({ data: { name: "local", isLocal: true, dockerSocket: process.env.DOCKER_SOCKET || "/var/run/docker.sock" } });
  }

  // plans area: Hobby (default) / Pro / Team / Unlimited (internal — the platform owner's teams resolve to it automatically)
  const plans = await ensureDefaultPlans();
  if (plans.created.length) console.log(`Plans created: ${plans.created.join(", ")}`);

  console.log(`Seeded: ${email} / Admin@12345 → team /${team.slug}, project demo-app`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
