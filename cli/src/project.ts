import path from "node:path";
import { Client, CliError } from "./api.js";
import { readConfig, readLink, writeLink, type ProjectLink } from "./config.js";
import { ask, c, confirm, info, isTTY, ok, select } from "./ui.js";

export type ProjectSummary = { id: string; name: string; slug: string; framework: string | null; sourceType: string; productionUrl: string; latestDeployment: { status: string; url: string; createdAt: string } | null };

export async function listProjects(client: Client, team?: string | null) {
  return client.request<{ team: { slug: string; name: string }; items: ProjectSummary[] }>("GET", "/api/v1/projects", { query: { team: team ?? undefined, limit: 100 } });
}

/** Link `dir` to a project: --project flag, interactive picker, or create a new one. */
export async function linkProject(client: Client, dir: string, opts: { project?: string; team?: string; yes?: boolean; name?: string } = {}): Promise<ProjectLink> {
  const team = opts.team ?? readConfig().team ?? undefined;
  const { team: t, items } = await listProjects(client, team);
  let chosen: ProjectSummary | null = null;
  if (opts.project) {
    chosen = items.find((p) => p.slug === opts.project || p.id === opts.project || p.name === opts.project) ?? null;
    if (!chosen && !opts.yes) throw new CliError(`Project "${opts.project}" not found in ${t.slug}`);
  } else if (!opts.yes && isTTY()) {
    const base = path.basename(dir);
    const existing = items.find((p) => p.slug === base.toLowerCase());
    if (existing && (await confirm(`Link to existing project ${c.bold(`${t.slug}/${existing.slug}`)}?`))) chosen = existing;
    else if (items.length && !(await confirm(`Create a new project?`, !existing))) {
      chosen = await select(
        "Which project?",
        items.map((p) => ({ label: `${p.slug} ${c.dim(p.framework ?? "")}`, value: p })),
      );
    }
  } else {
    chosen = items.find((p) => p.slug === (opts.name ?? path.basename(dir)).toLowerCase()) ?? null;
  }
  if (!chosen) {
    const name = opts.name ?? opts.project ?? (opts.yes || !isTTY() ? path.basename(dir) : await ask("Project name?", path.basename(dir)));
    const r = await client.request<{ project: { id: string; slug: string; name: string; teamSlug: string } }>("POST", "/api/v1/projects", {
      body: { team: t.slug, name, source: { type: "none" }, deploy: false },
    });
    ok(`Created project ${c.bold(`${r.project.teamSlug}/${r.project.slug}`)}`);
    chosen = { id: r.project.id, slug: r.project.slug, name: r.project.name, framework: null, sourceType: "UPLOAD", productionUrl: "", latestDeployment: null };
  }
  const link: ProjectLink = { server: client.server, projectId: chosen.id, projectSlug: chosen.slug, teamSlug: t.slug };
  writeLink(dir, link);
  ok(`Linked ${c.dim(dir)} → ${c.bold(`${t.slug}/${chosen.slug}`)} ${c.dim("(.levant/project.json)")}`);
  return link;
}

/** The linked project of `dir` (or --project), linking interactively when needed. */
export async function resolveProject(client: Client, dir: string, opts: { project?: string; team?: string; yes?: boolean; autoLink?: boolean } = {}): Promise<ProjectLink> {
  if (opts.project) {
    const { team, items } = await listProjects(client, opts.team);
    const p = items.find((x) => x.slug === opts.project || x.id === opts.project);
    if (!p) throw new CliError(`Project "${opts.project}" not found`);
    return { server: client.server, projectId: p.id, projectSlug: p.slug, teamSlug: team.slug };
  }
  const link = readLink(dir);
  if (link && link.server === client.server) return link;
  if (opts.autoLink === false) throw new CliError("This folder is not linked to a project. Run `levant link` (or pass --project).");
  info(c.dim(link ? `Linked to another server (${link.server}); re-linking.` : "This folder is not linked yet."));
  return linkProject(client, dir, { team: opts.team, yes: opts.yes });
}
