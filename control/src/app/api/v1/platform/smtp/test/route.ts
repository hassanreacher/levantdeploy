import { z } from "zod";
import { route, json, body, requirePlatformOwner, throttle, E, ApiError } from "@/lib/http";
import { sendMail } from "@/lib/email";
import { emailSchema } from "@/lib/auth/password";

/** POST { to } → sends a test email with the effective SMTP configuration. */
export const POST = route(async (req) => {
  const actor = await requirePlatformOwner();
  await throttle(`smtp-test:${actor.user.id}`, { limit: 5, window: 60 });
  const { to } = await body(req, z.object({ to: emailSchema }));
  try {
    const r = await sendMail({
      to,
      subject: "LevantDeploy test email",
      text: "This is a test email from your LevantDeploy instance. If you can read this, SMTP is configured correctly.",
    });
    if (!r.delivered) throw E.bad("SMTP is not configured — the message was only printed to the server log");
    return json({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw E.bad(`SMTP error: ${(e as Error).message}`.slice(0, 500));
  }
});
