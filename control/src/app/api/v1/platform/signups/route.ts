import { z } from "zod";
import { route, json, body, requirePlatformOwner } from "@/lib/http";
import { setSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { signupPolicy } from "@/lib/plans/signup";

/** GET|PATCH /api/v1/platform/signups — registration mode + sign-up protection (platform owner; plans area). */
export const GET = route(async () => {
  await requirePlatformOwner();
  return json({ policy: await signupPolicy() });
});

const url = z.string().trim().url().nullable().or(z.literal("").transform(() => null));
const schema = z
  .object({
    registration: z.enum(["open", "invite", "closed"]),
    requireEmailVerification: z.boolean(),
    blockDisposableEmails: z.boolean(),
    disposableDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Not a domain")).max(5000),
    signupRateLimit: z.object({ limit: z.number().int().min(1).max(1000), windowMinutes: z.number().int().min(1).max(10_080) }),
    requireTerms: z.boolean(),
    termsUrl: url,
    privacyUrl: url,
  })
  .partial();

export const PATCH = route(async (req) => {
  const actor = await requirePlatformOwner();
  const i = await body(req, schema);
  const map = {
    registration: "platform.registration",
    requireEmailVerification: "auth.requireEmailVerification",
    blockDisposableEmails: "auth.blockDisposableEmails",
    disposableDomains: "auth.disposableDomains",
    signupRateLimit: "auth.signupRateLimit",
    requireTerms: "auth.requireTerms",
    termsUrl: "auth.termsUrl",
    privacyUrl: "auth.privacyUrl",
  } as const;
  const changed: string[] = [];
  for (const [k, key] of Object.entries(map) as [keyof typeof map, (typeof map)[keyof typeof map]][]) {
    if (i[k] === undefined) continue;
    await setSetting(key, i[k] as never);
    changed.push(key);
  }
  if (changed.length) await audit({ action: "platform.settings_update", actor, targetType: "platform", meta: { keys: changed } });
  return json({ policy: await signupPolicy() });
});
