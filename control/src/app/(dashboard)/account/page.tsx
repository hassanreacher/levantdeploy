import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { AccountClient } from "./account-client";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const s = await getSession();
  if (!s) redirect("/login?next=/account");
  const sessions = await db.session.findMany({
    where: { userId: s.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });
  return (
    <>
      <PageHeader title="Account Settings" description={s.user.email} />
      <PageBody className="max-w-3xl">
        <AccountClient
          user={{ name: s.user.name, email: s.user.email, totpEnabled: s.user.totpEnabled }}
          sessions={sessions.map((x) => ({
            id: x.id,
            ip: x.ip,
            userAgent: x.userAgent,
            lastSeenAt: x.lastSeenAt.toISOString(),
            createdAt: x.createdAt.toISOString(),
            current: x.id === s.sessionId,
          }))}
        />
      </PageBody>
    </>
  );
}
