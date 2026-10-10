import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client, CliError } from "../api.js";
import { packDirectory } from "../pack.js";
import { uploadFile } from "../upload.js";
import { streamLogs } from "../logs.js";
import { resolveProject } from "../project.js";
import { logText, c, fail, formatBytes, info, ok, progress, status as fmtStatus } from "../ui.js";
import { VERSION } from "../version.js";

export type Deployment = {
  id: string;
  number: number;
  status: string;
  target: string;
  url: string;
  fullUrl: string;
  errorMessage: string | null;
  branch: string | null;
  commitSha: string | null;
  createdAt: string;
  isCurrentProduction: boolean;
};

const FINAL = new Set(["READY", "ERROR", "CANCELED", "SUPERSEDED"]);

function gitInfo(dir: string) {
  const run = (...a: string[]) => {
    try {
      return execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const sha = run("rev-parse", "HEAD");
  if (!sha) return null;
  return { branch: run("rev-parse", "--abbrev-ref", "HEAD"), sha, message: run("log", "-1", "--format=%s"), dirty: !!run("status", "--porcelain") };
}

export function parseEnvFlags(list: string[] = []): Array<{ key: string; value: string }> {
  return list.map((kv) => {
    const i = kv.indexOf("=");
    if (i <= 0) throw new CliError(`--env expects KEY=value (got "${kv}")`);
    const key = kv.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new CliError(`Invalid env var name "${key}"`);
    return { key, value: kv.slice(i + 1) };
  });
}

export async function deploy(client: Client, dirArg: string | undefined, opts: { prod?: boolean; env?: string[]; yes?: boolean; wait?: boolean; project?: string; team?: string; logs?: boolean }) {
  client.requireToken();
  const dir = path.resolve(dirArg ?? ".");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new CliError(`${dir} is not a directory`);
  const envs = parseEnvFlags(opts.env);
  const link = await resolveProject(client, dir, { project: opts.project, team: opts.team, yes: opts.yes });
  const target = opts.prod ? "PRODUCTION" : "PREVIEW";

  if (envs.length) {
    await client.request("POST", `/api/v1/projects/${link.projectId}/env`, { body: { items: envs.map((e) => ({ ...e, targets: [target] })), targets: [target], overwrite: true } });
    ok(`Set ${envs.length} ${target.toLowerCase()} env var${envs.length > 1 ? "s" : ""}: ${envs.map((e) => e.key).join(", ")}`);
  }

  const t0 = Date.now();
  const packed = await packDirectory(dir);
  info(`${c.dim("›")} Packed ${packed.files.length} files ${c.dim(`(${formatBytes(packed.size)})`)}`);
  const bar = progress("  Uploading");
  const up = await uploadFile(client, packed.file, { size: packed.size, sha256: packed.sha256, projectId: link.projectId }, (s, t) => bar.update(s, t));
  bar.done();
  fs.rmSync(path.dirname(packed.file), { recursive: true, force: true });
  info(`${c.dim("›")} Uploaded ${c.dim(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`)}`);

  const g = gitInfo(dir);
  const created = await client.request<{ deployment: { id: string; number: number }; url: string; inspectUrl: string }>("POST", `/api/v1/uploads/${up.id}/deploy`, {
    body: {
      projectId: link.projectId,
      target,
      branch: g?.branch && g.branch !== "HEAD" ? g.branch : null,
      commitSha: g?.sha ?? null,
      commitMessage: g?.message ? `${g.message}${g.dirty ? " (uncommitted changes)" : ""}` : null,
      meta: { cli: VERSION, dirty: g?.dirty ?? null, node: process.version },
    },
  });
  info(`${c.dim("›")} Inspect: ${c.underline(created.inspectUrl)}`);
  info(`${c.dim("›")} ${opts.prod ? "Production" : "Preview"}: ${c.underline(created.url)} ${c.dim(`#${created.deployment.number}`)}`);
  if (opts.wait === false) {
    console.log(created.url);
    return 0;
  }

  // stream build logs while polling the status
  const ctl = new AbortController();
  let final: Deployment | null = null;
  const poll = (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = await client.request<{ deployment: Deployment; aliases: string[] }>("GET", `/api/v1/deployments/${created.deployment.id}`).catch(() => null);
      if (d && FINAL.has(d.deployment.status)) {
        final = d.deployment;
        (final as Deployment & { aliases?: string[] }).aliases = d.aliases;
        await new Promise((r) => setTimeout(r, 800)); // let the last log lines arrive
        ctl.abort();
        return;
      }
    }
  })();
  const onSig = () => {
    info(c.dim(`\nStopped watching. The deployment continues on the server: ${created.inspectUrl}`));
    process.exit(130);
  };
  process.once("SIGINT", onSig);
  if (opts.logs !== false) {
    await streamLogs(client, created.deployment.id, {
      signal: ctl.signal,
      onLine: (l) => process.stderr.write(`${c.dim(new Date(l.ts).toISOString().slice(11, 19))}  ${logText(l.line, process.stderr)}\n`),
    }).catch(() => {});
  }
  await poll;
  process.off("SIGINT", onSig);
  const d = final as (Deployment & { aliases?: string[] }) | null;
  if (!d) throw new CliError("Lost track of the deployment");
  info("");
  if (d.status === "READY") {
    ok(`${c.bold("Ready")} ${c.dim(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`)}`);
    for (const a of d.aliases ?? []) info(`${c.dim("›")} Aliased: ${c.underline(`${d.fullUrl.split("://")[0]}://${a}`)}`);
    console.log(d.fullUrl);
    return 0;
  }
  fail(`${fmtStatus(d.status)}${d.errorMessage ? ` — ${d.errorMessage}` : ""}`);
  info(c.dim(`See ${created.inspectUrl}`));
  return 1;
}
