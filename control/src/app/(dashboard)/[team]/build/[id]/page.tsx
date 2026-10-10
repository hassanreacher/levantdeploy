import type { Metadata } from "next";
import { getTeamContext } from "@/lib/auth/context";
import { EditorLoader } from "@/components/builder/editor/loader";

export const metadata: Metadata = { title: "Builder" };

/** /{team}/build/{id} — full-screen AI app Builder editor (builder-ui). Membership is enforced by getTeamContext. */
export default async function BuilderEditorPage({ params }: { params: Promise<{ team: string; id: string }> }) {
  const { team, id } = await params;
  const ctx = await getTeamContext(team);
  return <EditorLoader team={ctx.team.slug} role={ctx.role} id={id} />;
}
