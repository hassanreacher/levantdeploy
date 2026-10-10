import Link from "next/link";
import { getUser } from "@/lib/auth/session";
import { findValidInvite } from "@/lib/auth/register";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { LinkButton } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { AcceptInvite } from "./accept";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team invite" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await findValidInvite(token);
  const user = await getUser();
  if (!inv) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Invite expired</h1>
        <p className="mt-2 text-sm text-muted">This invite link is invalid, was revoked, or has already been used.</p>
        <Link href="/" className="link mt-6 inline-block text-sm">
          Go to dashboard
        </Link>
      </div>
    );
  }
  return (
    <div className="text-center">
      <Avatar name={inv.team.name + inv.team.slug} size={56} className="mx-auto mb-5" />
      <h1 className="text-2xl font-semibold tracking-tight">Join {inv.team.name}</h1>
      <p className="mt-2 text-sm text-muted">
        You&apos;ve been invited as <span className="text-fg">{ROLE_LABEL[inv.role]}</span>
        {inv.email ? (
          <>
            {" "}
            (<span className="text-fg">{inv.email}</span>)
          </>
        ) : null}
        .
      </p>
      <div className="mt-8 space-y-3">
        {user ? (
          <AcceptInvite token={token} email={user.email} />
        ) : (
          <>
            <LinkButton href={`/register?invite=${encodeURIComponent(token)}`} variant="primary" size="lg" className="w-full">
              Create an account
            </LinkButton>
            <LinkButton href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} variant="secondary" size="lg" className="w-full">
              I already have an account
            </LinkButton>
          </>
        )}
      </div>
    </div>
  );
}
