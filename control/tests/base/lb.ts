/**
 * Dev helper for the LevantBase e2e (tests/base/e2e.sh). Run from control/ with the area env loaded:
 *   npx tsx tests/base/lb.ts <cmd> …
 *   create <name>            → prints ref            keys <ref>            → JSON {url, anonKey, serviceRoleKey}
 *   sql <ref> <role> <sql>   → JSON result           action <ref> <action> [json opts]
 *   wait <ref> <STATUS> [s]  → waits for the status   fn <ref> <slug> <file> [verifyJwt]
 *   studio-token <ref>       → one-time SSO URL       backups <ref>         → JSON list
 *   conn <ref>               → connection strings     public <ref> on|off   → setPublicPort
 *   job-wait <ref> <eventType> <isoSince>            → waits for a success/error BaseEvent of that type
 *   api-token [name]         → new API token (scopes *) for the seeded admin (compat suite / CLI checks)
 */
import fs from "node:fs";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { baseKeys, connectionStrings, createBaseProject, deployFunction, runSql, setPublicPort, stackAction, issueStudioToken } from "@/lib/base";

async function admin() {
  const team = await db.team.findFirstOrThrow({ where: { slug: "admin" } });
  const user = await db.user.findFirstOrThrow({ where: { email: "admin@levantdeploy.local" } });
  return { team, user };
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  switch (cmd) {
    case "create": {
      const { team, user } = await admin();
      return (await createBaseProject({ teamId: team.id, name: a[0] ?? "e2e", createdById: user.id })).ref;
    }
    case "conn":
      return JSON.stringify(await connectionStrings(a[0]!));
    case "public": {
      const { user } = await admin();
      return JSON.stringify(await setPublicPort(a[0]!, a[1] === "on", user.id));
    }
    case "job-wait": {
      // wait until the latest BaseEvent of a type is newer than the given ISO time
      const p = await db.baseProject.findUniqueOrThrow({ where: { ref: a[0]! } });
      const since = new Date(a[2]!);
      const deadline = Date.now() + 600_000;
      for (;;) {
        const e = await db.baseEvent.findFirst({ where: { baseProjectId: p.id, type: a[1]!, createdAt: { gt: since }, level: { in: ["success", "error"] } }, orderBy: { createdAt: "desc" } });
        if (e) return `${e.level}: ${e.message}`;
        const q = await db.baseProject.findUniqueOrThrow({ where: { ref: a[0]! } });
        if (q.status === "ERROR") throw new Error(`ERROR: ${q.statusMessage}`);
        if (Date.now() > deadline) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case "keys":
      return JSON.stringify(await baseKeys(a[0]!));
    case "sql":
      return JSON.stringify(await runSql(a[0]!, a[2]!, { role: a[1] as never }));
    case "action": {
      const { user } = await admin();
      return JSON.stringify(await stackAction(a[0]!, a[1] as never, { byUserId: user.id, ...(a[2] ? JSON.parse(a[2]) : {}) }));
    }
    case "wait": {
      const deadline = Date.now() + Number(a[2] ?? 600) * 1000;
      for (;;) {
        const p = await db.baseProject.findUnique({ where: { ref: a[0]! } });
        if (p?.status === a[1]) return p.status;
        if (p?.status === "ERROR" && a[1] !== "ERROR") throw new Error(`ERROR: ${p.statusMessage}`);
        if (Date.now() > deadline) throw new Error(`timeout (status ${p?.status})`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case "fn": {
      const { user } = await admin();
      const r = await deployFunction(a[0]!, { slug: a[1]!, source: fs.readFileSync(a[2]!, "utf8"), verifyJwt: a[3] !== "false", byUserId: user.id });
      return JSON.stringify({ jobId: r.jobId, url: r.url, version: r.function.version });
    }
    case "studio-token": {
      const { user } = await admin();
      return (await issueStudioToken(a[0]!, user.id)).url;
    }
    case "api-token": {
      const { user } = await admin();
      return (await createApiToken({ userId: user.id, name: a[0] ?? "compat", scopes: ["*"] })).token;
    }
    case "backups": {
      const p = await db.baseProject.findUniqueOrThrow({ where: { ref: a[0]! } });
      const rows = await db.baseBackup.findMany({ where: { baseProjectId: p.id }, orderBy: { createdAt: "desc" } });
      return JSON.stringify(rows.map((b) => ({ ...b, sizeBytes: b.sizeBytes?.toString(), storageSizeBytes: b.storageSizeBytes?.toString() })));
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main()
  .then((out) => {
    if (out !== undefined) console.log(out);
    process.exit(0);
  })
  .catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
