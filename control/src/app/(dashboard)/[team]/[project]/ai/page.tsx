import { db } from "@/lib/db";
import { getProjectContext } from "@/lib/auth/context";
import { readDiagnosis } from "@/lib/ai/auto-diagnose";
import { AiPageClient } from "./ai-page-client";

export const metadata = { title: "AI Agent" };
export const dynamic = "force-dynamic";

export default async function AiPage({ params, searchParams }: { params: Promise<{ team: string; project: string }>; searchParams: Promise<{ c?: string; ask?: string; send?: string }> }) {
  const { team, project } = await params;
  const sp = await searchParams;
  const ctx = await getProjectContext(team, project);
  const failed = await db.deployment.findMany({
    where: { projectId: ctx.project.id, status: "ERROR" },
    orderBy: { number: "desc" },
    take: 3,
    select: { id: true, number: true, errorStep: true, errorMessage: true, branch: true, createdAt: true, meta: true },
  });
  return (
    <AiPageClient
      team={ctx.team.slug}
      project={ctx.project.slug}
      projectName={ctx.project.name}
      initialConversationId={sp.c ?? null}
      initialPrompt={sp.ask ?? null}
      autoSend={sp.send === "1"}
      failures={failed.map((d) => ({ id: d.id, number: d.number, errorStep: d.errorStep, errorMessage: d.errorMessage, branch: d.branch, createdAt: d.createdAt.toISOString(), diagnosis: readDiagnosis(d.meta) }))}
    />
  );
}
