import { signupPolicy } from "@/lib/plans/signup";
import { db } from "@/lib/db";
import { SignupsSettings } from "./signups-client";

export const metadata = { title: "Sign-ups · Platform Settings" };
export const dynamic = "force-dynamic";

export default async function PlatformSignupsPage() {
  const since = new Date(Date.now() - 7 * 86400_000);
  const [policy, recent, unverified] = await Promise.all([
    signupPolicy(),
    db.user.count({ where: { createdAt: { gte: since } } }),
    db.user.count({ where: { emailVerifiedAt: null } }),
  ]);
  return <SignupsSettings policy={policy} stats={{ recent, unverified }} />;
}
