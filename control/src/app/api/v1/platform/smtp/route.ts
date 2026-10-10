import { z } from "zod";
import { route, json, body, requirePlatformOwner } from "@/lib/http";
import { getSetting, setSetting } from "@/lib/settings";
import { encryptString } from "@/lib/crypto";
import { audit } from "@/lib/audit";

/** PUT → save SMTP settings (password: omit/undefined = keep current, "" = clear). DELETE → fall back to env SMTP_*. */
const schema = z.object({
  host: z.string().trim().min(1, "Enter the SMTP host").max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z
    .string()
    .trim()
    .max(255)
    .transform((s) => s || null)
    .nullable(),
  password: z.string().max(1024).optional(),
  from: z.string().trim().min(3, "Enter a sender, e.g. LevantDeploy <no-reply@example.com>").max(255),
});

export const PUT = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, schema);
  const cur = await getSetting("smtp");
  const passEnc = input.password === undefined ? (cur?.passEnc ?? null) : input.password ? encryptString(input.password) : null;
  await setSetting("smtp", { host: input.host, port: input.port, secure: input.secure, user: input.user, passEnc, from: input.from });
  await audit({ action: "platform.smtp_update", actor, targetType: "platform", meta: { host: input.host, port: input.port } });
  return json({ ok: true });
});

export const DELETE = route(async () => {
  const actor = await requirePlatformOwner();
  await setSetting("smtp", null);
  await audit({ action: "platform.smtp_reset", actor, targetType: "platform" });
  return json({ ok: true });
});
