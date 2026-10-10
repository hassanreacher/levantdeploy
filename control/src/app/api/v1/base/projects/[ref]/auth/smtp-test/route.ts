import { z } from "zod";
import { route, json, body, throttle, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { testSmtp } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { smtpConfig } from "@/lib/base-ui/settings";

/** POST /api/v1/base/projects/:ref/auth/smtp-test { to } — ADMIN: sends a test email with the saved SMTP settings. */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const { to } = await body(req, z.object({ to: z.string().trim().email("Enter an email address").max(255) }));
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  await throttle(`base:smtp-test:${actor.user.id}`, { limit: 5, window: 300 });
  if (!smtpConfig(base.settings)) throw E.bad("Save the SMTP settings first");
  try {
    await testSmtp(ref, to);
  } catch (e) {
    throw E.bad(`SMTP test failed: ${(e as Error).message.slice(0, 500)}`);
  }
  await audit({ action: "base.smtp_test", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, to } });
  return json({ ok: true });
});
