import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth/session";
import { TEAM_COOKIE } from "@/lib/auth/jwt";
import { teamsForUser } from "@/lib/teams";
import { Landing } from "@/components/landing/landing";
import { getPublicPlans } from "@/components/landing/plans";
import { getRegistrationMode } from "@/components/landing/mode";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "LevantDeploy — Describe it. We build it, host it, and give it a backend." },
  description:
    "Self-hosted AI app builder and cloud: describe an app and AI agents build it with its own database, auth and storage; edit it visually, publish it to your domain — or deploy your own code with previews, HTTPS and instant rollback.",
};

/** "/" → signed in: the last used team (cookie) or the personal team. Signed out: the product landing page. */
export default async function Home() {
  const user = await getUser();
  if (!user) {
    const [mode, { plans }] = await Promise.all([getRegistrationMode(), getPublicPlans()]);
    return <Landing mode={mode} plans={plans} />;
  }
  const teams = await teamsForUser(user.id);
  const pref = (await cookies()).get(TEAM_COOKIE)?.value;
  const team = teams.find((t) => t.slug === pref) ?? teams[0];
  if (!team) redirect("/account");
  redirect(`/${team.slug}`);
}
