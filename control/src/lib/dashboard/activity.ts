import { db } from "@/lib/db";

export type ActivityItem = {
  id: string;
  at: string;
  kind: "deployment" | "audit";
  /** deployment status for deployment items (QUEUED = created) */
  status?: string;
  actor: { name: string; avatar: string | null } | null;
  project: { name: string; slug: string; framework: string | null } | null;
  deployment?: { id: string; number: number; shortId: string; target: string; branch: string | null; commitMessage: string | null; trigger: string };
  action?: string;
  text: string;
};

const AUDIT_TEXT: Record<string, (m: Record<string, unknown>) => string> = {
  "project.create": () => "created the project",
  "project.update": (m) => `updated project settings${Array.isArray(m.fields) ? ` (${(m.fields as string[]).slice(0, 3).join(", ")})` : ""}`,
  "project.delete": (m) => `deleted project ${m.name ?? ""}`,
  "project.transfer": (m) => `transferred ${m.name ?? "a project"} from ${m.from} to ${m.to}`,
  "env.create": (m) => `added environment variable${Array.isArray(m.keys) && (m.keys as string[]).length > 1 ? "s" : ""} ${Array.isArray(m.keys) ? (m.keys as string[]).slice(0, 3).join(", ") : ""}`,
  "env.update": (m) => `updated environment variable ${m.key ?? (Array.isArray(m.keys) ? (m.keys as string[]).join(", ") : "")}`,
  "env.delete": (m) => `removed environment variable ${m.key ?? ""}`,
  "env.reveal": (m) => `revealed secret ${m.key ?? ""}`,
  "domain.add": (m) => `added domain ${m.hostname ?? ""}`,
  "domain.remove": (m) => `removed domain ${m.hostname ?? ""}`,
  "member.role_change": (m) => `changed ${m.name ?? "a member"}'s role to ${String(m.role ?? "").toLowerCase()}`,
  "member.remove": () => "removed a member",
  "invite.create": (m) => `invited ${m.email ?? "a member"}`,
  "notification.create": (m) => `added notification channel ${m.name ?? ""}`,
  "deployment.promote": (m) => `promoted deployment${m.number ? ` #${m.number}` : ""} to production`,
  "deployment.rollback": (m) => `rolled back production${m.number ? ` to #${m.number}` : ""}`,
  "deployment.cancel": (m) => `canceled deployment${m.number ? ` #${m.number}` : ""}`,
};

const SKIP = new Set(["deployment.create", "deployment.redeploy", "auth.login", "auth.logout", "env.pull"]);

/** Team activity: deployment lifecycle (created / ready / failed / canceled) merged with audit log entries. */
export async function teamActivity(teamId: string, opts: { limit?: number; before?: Date; projectId?: string } = {}): Promise<ActivityItem[]> {
  const limit = Math.min(opts.limit ?? 40, 200);
  const before = opts.before ?? new Date(Date.now() + 1000);
  const projectWhere = { teamId, ...(opts.projectId ? { id: opts.projectId } : {}) };
  const [events, audits] = await Promise.all([
    db.deploymentEvent.findMany({
      where: { createdAt: { lt: before }, status: { in: ["QUEUED", "READY", "ERROR", "CANCELED"] }, deployment: { project: projectWhere } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        deployment: {
          select: {
            id: true,
            number: true,
            shortId: true,
            target: true,
            branch: true,
            commitMessage: true,
            commitAuthor: true,
            commitAuthorAvatar: true,
            trigger: true,
            createdBy: { select: { name: true, avatar: true } },
            project: { select: { name: true, slug: true, framework: true } },
          },
        },
      },
    }),
    db.auditLog.findMany({
      where: { teamId, createdAt: { lt: before }, action: { notIn: [...SKIP] }, ...(opts.projectId ? { targetId: opts.projectId } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { name: true, avatar: true } } },
    }),
  ]);
  const projIds = [...new Set(audits.map((a) => a.targetId).filter(Boolean) as string[])];
  const projs = projIds.length ? await db.project.findMany({ where: { id: { in: projIds }, teamId }, select: { id: true, name: true, slug: true, framework: true } }) : [];
  const pmap = new Map(projs.map((p) => [p.id, p]));

  const items: ActivityItem[] = [
    ...events.map((e): ActivityItem => {
      const d = e.deployment;
      const who = d.createdBy ?? (d.commitAuthor ? { name: d.commitAuthor, avatar: d.commitAuthorAvatar } : null);
      const env = d.target === "PRODUCTION" ? "Production" : "Preview";
      const text =
        e.status === "QUEUED"
          ? `${d.trigger === "REDEPLOY" ? "redeployed" : d.trigger === "ROLLBACK" ? "rolled back" : d.trigger === "PROMOTE" ? "promoted" : "deployed"} to ${env}`
          : e.status === "READY"
            ? `${env} deployment is ready`
            : e.status === "ERROR"
              ? `${env} deployment failed`
              : `${env} deployment was canceled`;
      return {
        id: `e:${e.id}`,
        at: e.createdAt.toISOString(),
        kind: "deployment",
        status: e.status,
        actor: e.status === "QUEUED" ? who : null,
        project: d.project,
        deployment: { id: d.id, number: d.number, shortId: d.shortId, target: d.target, branch: d.branch, commitMessage: d.commitMessage, trigger: d.trigger },
        text,
      };
    }),
    ...audits.map((a): ActivityItem => {
      const meta = (a.meta as Record<string, unknown>) ?? {};
      const f = AUDIT_TEXT[a.action];
      return {
        id: `a:${a.id}`,
        at: a.createdAt.toISOString(),
        kind: "audit",
        action: a.action,
        actor: a.user ? { name: a.user.name, avatar: a.user.avatar } : null,
        project: (a.targetId && pmap.get(a.targetId)) || null,
        text: f ? f(meta).trim() : a.action.replace(/[._]/g, " "),
      };
    }),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
