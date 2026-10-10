import { requireUser } from "@/lib/auth/session";
import { teamsForUser } from "@/lib/teams";
import { describeUserCode, normalizeUserCode } from "@/lib/git/cli-auth";
import { AuthorizeClient } from "./authorize-client";

export const metadata = { title: "Authorize CLI" };
export const dynamic = "force-dynamic";

export default async function CliAuthorizePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = "" } = await searchParams;
  const user = await requireUser(`/cli/authorize${code ? `?code=${encodeURIComponent(code)}` : ""}`);
  const teams = await teamsForUser(user.id);
  const info = code ? await describeUserCode(code) : null;
  return (
    <AuthorizeClient
      code={code ? normalizeUserCode(code) : ""}
      info={info}
      user={{ name: user.name, email: user.email }}
      teams={teams.map((t) => ({ slug: t.slug, name: t.name }))}
    />
  );
}
