/**
 * Runtime e2e driver (dev/test only):
 *   npx tsx --env-file=.env.runtime tests/runtime/rt.ts project <slug> [kind=WEB] [port=3000] [healthPath=/]  → creates/updates project in team "admin"
 *   npx tsx --env-file=.env.runtime tests/runtime/rt.ts deploy <slug> <image> [PRODUCTION|PREVIEW] [branch]   → deployment through the worker, waits
 *   npx tsx --env-file=.env.runtime tests/runtime/rt.ts compose <slug> <composeFile>                          → COMPOSE deployment (build-area meta format)
 *   npx tsx --env-file=.env.runtime tests/runtime/rt.ts action <deploymentId> rollback|restart|stop|start|scale [replicas]
 *   npx tsx --env-file=.env.runtime tests/runtime/rt.ts sync | state | wait <deploymentId>
 * Prints JSON.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { db } from "@/lib/db";
import { createDeployment, setStatus } from "@/lib/deployments";
import { queues } from "@/lib/queues";
import { encryptJson } from "@/lib/crypto";
import { syncRoutes } from "@/lib/proxy/sync";
import { loadProxyState } from "@/lib/proxy/state";
import { redis } from "@/lib/redis";
import type { ProjectKind } from "@prisma/client";

const [cmd, ...args] = process.argv.slice(2);

async function waitFinal(id: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const d = await db.deployment.findUniqueOrThrow({ where: { id } });
    if (["READY", "ERROR", "CANCELED"].includes(d.status)) return d;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${id} (${d.status})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function team() {
  return db.team.findUniqueOrThrow({ where: { slug: "admin" } });
}

async function main() {
  switch (cmd) {
    case "project": {
      const [slug, kind = "WEB", port = "3000", health = "/"] = args;
      const t = await team();
      const data = { name: slug!, kind: kind as ProjectKind, port: Number(port), healthcheckPath: health === "none" ? null : health, sourceType: "IMAGE" as const };
      const p = await db.project.upsert({ where: { teamId_slug: { teamId: t.id, slug: slug! } }, create: { teamId: t.id, slug: slug!, ...data }, update: data });
      return { id: p.id, slug: p.slug };
    }
    case "deploy": {
      const [slug, image, target = "PRODUCTION", branch = "main"] = args;
      const t = await team();
      const p = await db.project.findUniqueOrThrow({ where: { teamId_slug: { teamId: t.id, slug: slug! } } });
      const d = await createDeployment({ projectId: p.id, target: target as "PRODUCTION" | "PREVIEW", source: { branch, commitSha: Math.random().toString(16).slice(2, 10), commitMessage: `deploy ${image}` }, trigger: "API", enqueue: false });
      await setStatus(d.id, "DEPLOYING", { imageTag: image });
      await queues.deploy.add({ deploymentId: d.id });
      if (args.includes("--nowait")) return { id: d.id, url: d.url };
      const f = await waitFinal(d.id);
      return { id: f.id, number: f.number, url: f.url, status: f.status, error: f.errorMessage, containers: f.containerIds };
    }
    case "compose": {
      const [slug, file] = args;
      const t = await team();
      const p = await db.project.findUniqueOrThrow({ where: { teamId_slug: { teamId: t.id, slug: slug! } } });
      const abs = path.resolve(file!);
      const json = execFileSync("docker", ["compose", "-f", abs, "config", "--format", "json"], { cwd: path.dirname(abs) }).toString();
      const spec = JSON.parse(json);
      const services = Object.entries(spec.services as Record<string, { image: string; ports?: Array<{ target: number }> }>).map(([name, s]) => ({
        name,
        image: s.image,
        built: false,
        ports: (s.ports ?? []).map((x) => x.target),
        definition: {},
      }));
      const d = await createDeployment({ projectId: p.id, target: "PRODUCTION", source: { branch: "main" }, trigger: "API", enqueue: false });
      await setStatus(d.id, "DEPLOYING", {
        imageTag: services[0]!.image,
        meta: { build: { framework: "compose", kind: "COMPOSE", strategy: "compose", port: 3000, compose: services, composePrimary: "web", composeSpecEnc: encryptJson(spec) } },
      });
      await queues.deploy.add({ deploymentId: d.id });
      const f = await waitFinal(d.id);
      return { id: f.id, url: f.url, status: f.status, error: f.errorMessage, containers: f.containerIds };
    }
    case "action": {
      const [id, action, n] = args;
      const job = await queues.deploy.add({ deploymentId: id!, action: action as "rollback", replicas: n ? Number(n) : undefined }, { jobId: `${action}-${id}-${Date.now()}` });
      const t0 = Date.now();
      for (;;) {
        const st = await job.getState();
        if (st === "completed" || st === "failed") {
          const j = await queues.deploy.raw.getJob(job.id!);
          return { state: st, failedReason: j?.failedReason ?? null, ms: Date.now() - t0 };
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    case "wait":
      return waitFinal(args[0]!);
    case "sync":
      return syncRoutes({ immediate: true });
    case "state": {
      const s = await loadProxyState();
      return { sites: s.sites, redirects: s.redirects };
    }
  }
  throw new Error(`unknown command ${cmd}`);
}

main()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await queues.deploy.close().catch(() => {});
    await redis().quit().catch(() => {});
    await db.$disconnect();
    process.exit();
  });
