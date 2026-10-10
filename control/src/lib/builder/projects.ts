import type { BuilderProject, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { assertCanCreateBuilderProject } from "@/lib/plans/enforce";
import { hostUrl, projectHost } from "@/lib/deployments";
import { createWorkspace, deleteWorkspace } from "./workspace";
import { deletePreview, previewBaseUrl } from "./preview";
import { DEFAULT_TEMPLATE, isTemplate, TEMPLATES } from "./template";

/**
 * Builder projects (builder-core): create (workspace from template + initial commit), DTO, delete.
 * "Create from prompt": the API creates the project, then `startInitialRun()` hands the prompt to the agents
 * (builder-agents `startRun({ mode: "build" })`) — the project exists even if that fails (credits, no providers).
 * Worker-safe.
 */

export class BuilderProjectError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** "build me a todo app with login" → "Todo App With Login" (≤ 40 chars) */
export function nameFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^(please\s+)?(build|create|make|generate|design|i\s+want|i\s+need)\s+(me\s+)?(an?\s+|the\s+)?/i, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6);
  let name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  if (name.length > 40) name = name.slice(0, 40).replace(/\s+\S*$/, "");
  return name || "My App";
}

export type CreateBuilderProjectInput = {
  teamId: string;
  userId: string;
  name?: string | null;
  prompt?: string | null;
  description?: string | null;
  template?: string | null;
  settings?: Record<string, unknown>;
};

export async function createBuilderProject(input: CreateBuilderProjectInput): Promise<BuilderProject> {
  const template = input.template ?? DEFAULT_TEMPLATE;
  if (!isTemplate(template)) throw new BuilderProjectError(400, `Unknown template "${template}"`);
  await assertCanCreateBuilderProject(input.teamId, { userId: input.userId });
  const name = (input.name?.trim() || (input.prompt ? nameFromPrompt(input.prompt) : "My App")).slice(0, 80);
  const row = await db.builderProject.create({
    data: {
      teamId: input.teamId,
      name,
      description: input.description?.slice(0, 500) ?? null,
      prompt: input.prompt?.slice(0, 20_000) ?? null,
      template,
      status: "DRAFT",
      settings: (input.settings ?? {}) as Prisma.InputJsonValue,
      createdById: input.userId,
    },
  });
  try {
    const { sha } = await createWorkspace(row.id, { template, name });
    return db.builderProject.update({ where: { id: row.id }, data: { lastCommit: sha, status: input.prompt ? "DRAFT" : "READY" } });
  } catch (e) {
    await db.builderProject.delete({ where: { id: row.id } }).catch(() => {});
    await deleteWorkspace(row.id).catch(() => {});
    throw e;
  }
}

/** Hand the creation prompt to the agents (builder-agents). Returns the run id or the reason it didn't start. */
export async function startInitialRun(
  builderId: string,
  input: { userId: string; prompt: string; attachments?: Array<{ url: string; name?: string; type?: string }> },
): Promise<{ runId: string | null; error: string | null; status?: number }> {
  try {
    const mod = (await import("./agents/runs")) as unknown as {
      startRun?: (i: { builderProjectId: string; userId: string; message: string; mode: string; attachments?: unknown[] }) => Promise<{ run?: { id: string }; id?: string } & Record<string, unknown>>;
    };
    if (typeof mod.startRun !== "function") return { runId: null, error: "The AI agents are not available on this server" };
    const r = await mod.startRun({ builderProjectId: builderId, userId: input.userId, message: input.prompt, mode: "build", attachments: input.attachments ?? [] });
    const runId = (r?.run as { id?: string } | undefined)?.id ?? (r as { id?: string }).id ?? null;
    return { runId, error: null };
  } catch (e) {
    const err = e as Error & { status?: number; statusCode?: number };
    return { runId: null, error: err.message, status: err.status ?? err.statusCode };
  }
}

export async function deleteBuilderProject(builderId: string) {
  await deletePreview(builderId).catch(() => {});
  await db.builderProject.delete({ where: { id: builderId } });
  await deleteWorkspace(builderId).catch(() => {});
}

type Row = BuilderProject & {
  project?: { id: string; slug: string; name: string } | null;
  createdBy?: { id: string; name: string; email: string } | null;
  runs?: Array<{ id: string; status: string }>;
};

/** API shape (matches src/lib/builder-ui/types.ts BuilderProject). Share token hashes are never exposed. */
export function builderProjectDTO(p: Row) {
  const settings = { ...((p.settings as Record<string, unknown>) ?? {}) };
  const share = settings.share as { expiresAt?: string | null } | undefined;
  delete settings.share;
  const active = p.runs?.find((r) => r.status === "QUEUED" || r.status === "RUNNING");
  return {
    id: p.id,
    teamId: p.teamId,
    name: p.name,
    description: p.description,
    prompt: p.prompt,
    template: p.template,
    status: p.status,
    previewStatus: p.previewStatus,
    previewUrl: previewBaseUrl(p.id),
    previewError: p.previewError,
    previewStartedAt: p.previewStartedAt?.toISOString() ?? null,
    baseRef: p.baseRef,
    projectId: p.projectId,
    project: p.project ? { ...p.project, url: hostUrl(projectHost(p.project.slug)) } : null,
    settings,
    share: share ? { enabled: !share.expiresAt || Date.parse(share.expiresAt) > Date.now(), expiresAt: share.expiresAt ?? null } : { enabled: false, expiresAt: null },
    lastCommit: p.lastCommit,
    lastPublishedAt: p.lastPublishedAt?.toISOString() ?? null,
    lastDeploymentId: p.lastDeploymentId,
    activeRunId: active?.id ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    createdBy: p.createdBy ? { id: p.createdBy.id, name: p.createdBy.name, email: p.createdBy.email } : null,
  };
}

export const DTO_INCLUDE = {
  project: { select: { id: true, slug: true, name: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  runs: { where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, status: true }, take: 1 },
} satisfies Prisma.BuilderProjectInclude;

/** Starter templates for the gallery (all on the next15 template; the prompt seeds the first agent run). */
export const STARTERS = [
  { id: "blank", name: "Blank Next.js app", description: TEMPLATES[0].description, prompt: "", tags: ["starter"] },
  { id: "saas-landing", name: "SaaS landing page", description: "Hero, features, pricing, testimonials, FAQ and a call to action.", prompt: "Build a modern SaaS landing page with a hero, features grid, pricing with three plans, testimonials, FAQ and a final call to action.", tags: ["marketing"] },
  { id: "todo-auth", name: "Todo app with login", description: "Sign up / sign in and personal todo lists stored in the backend.", prompt: "Build a todo app where users sign up and sign in with email and password, then create, complete and delete their own todos (stored in the database with row level security).", tags: ["app", "backend"] },
  { id: "restaurant", name: "Restaurant website", description: "Menu, gallery, opening hours and a reservation form.", prompt: "Build a website for a Levantine restaurant with a menu, photo gallery, opening hours, location and a table reservation form saved to the database.", tags: ["business", "backend"] },
  { id: "portfolio", name: "Portfolio", description: "Personal portfolio with projects, about and contact.", prompt: "Build a clean personal portfolio for a product designer with a projects grid, about section and a contact form.", tags: ["personal"] },
  { id: "dashboard", name: "Admin dashboard", description: "Sidebar layout with stats, a chart-like overview and a data table.", prompt: "Build an admin dashboard with a sidebar, KPI cards, a recent orders table with search, and a settings page.", tags: ["app"] },
] as const;
