import type { Metadata } from "next";
import { db } from "@/lib/db";
import { signupPolicy } from "@/lib/plans/signup";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Sign up" };
export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const sp = await searchParams;
  const users = await db.user.count();
  const policy = await signupPolicy();
  const mode = policy.registration;
  return (
    <RegisterForm
      firstUser={users === 0}
      open={users === 0 || mode === "open"}
      closed={users > 0 && mode === "closed"}
      invite={sp.invite}
      terms={users > 0 && policy.requireTerms ? { termsUrl: policy.termsUrl, privacyUrl: policy.privacyUrl } : null}
    />
  );
}
