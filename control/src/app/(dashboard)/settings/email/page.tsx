import { platformOverview } from "@/lib/ops/platform";
import { requireUser } from "@/lib/auth/session";
import { EmailSettings } from "./email-client";

export const metadata = { title: "Email · Platform Settings" };

export default async function PlatformEmailPage() {
  const [o, user] = await Promise.all([platformOverview(), requireUser("/settings/email")]);
  return <EmailSettings smtp={o.smtp} ownerEmail={user.email} />;
}
