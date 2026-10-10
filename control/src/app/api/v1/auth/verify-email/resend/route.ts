import { route, json, requireSession } from "@/lib/http";
import { resendVerification } from "@/lib/plans/signup";

/** POST /api/v1/auth/verify-email/resend → { sent: boolean, alreadyVerified } (signed-in user; 3 per 15 min). */
export const POST = route(async () => {
  const { user } = await requireSession();
  const r = await resendVerification(user.id);
  return json({ sent: !r.alreadyVerified, alreadyVerified: r.alreadyVerified });
});
