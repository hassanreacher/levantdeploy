import type { DeploymentStatus } from "@prisma/client";

/** Pure rendering of the PR comment (unit tested). */
export const COMMENT_MARKER = "<!-- levantdeploy:pr-comment -->";

export const STATUS_LABEL: Record<DeploymentStatus, string> = {
  QUEUED: "🕒 Queued",
  BUILDING: "🔄 Building",
  DEPLOYING: "🔄 Deploying",
  READY: "✅ Ready",
  ERROR: "❌ Failed",
  CANCELED: "⚪ Canceled",
  SUPERSEDED: "✅ Ready",
};


export type CommentRow = { project: string; status: DeploymentStatus; inspectUrl: string; previewUrl: string | null; branchUrl: string | null; updatedAt: number };

export function renderPrComment(rows: CommentRow[], dashboardUrl: string): string {
  const fmt = (t: number) =>
    new Date(t).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) + " UTC";
  const lines = [
    COMMENT_MARKER,
    `**The latest updates on your projects.** Learn more about [LevantDeploy](${dashboardUrl})`,
    "",
    "| Name | Status | Preview | Updated |",
    "| :--- | :----- | :------ | :------ |",
    ...rows
      .sort((a, b) => a.project.localeCompare(b.project))
      .map((r) => {
        const preview = r.status === "READY" && r.previewUrl ? `[Visit Preview](${r.previewUrl})` : "";
        return `| **${r.project.replace(/\|/g, "\\|")}** | ${STATUS_LABEL[r.status]} ([Inspect](${r.inspectUrl})) | ${preview} | ${fmt(r.updatedAt)} |`;
      }),
  ];
  return lines.join("\n");
}

