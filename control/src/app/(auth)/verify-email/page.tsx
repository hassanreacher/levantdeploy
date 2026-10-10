import type { Metadata } from "next";
import { getUser } from "@/lib/auth/session";
import { VerifyEmail } from "./verify-email";

export const metadata: Metadata = { title: "Verify email" };
export const dynamic = "force-dynamic";

/** /verify-email?token=… — the link from the verification email (plans area). The token is consumed client-side (POST) so link scanners can't burn it. */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const sp = await searchParams;
  const user = await getUser();
  return <VerifyEmail token={sp.token ?? null} signedIn={!!user} />;
}
