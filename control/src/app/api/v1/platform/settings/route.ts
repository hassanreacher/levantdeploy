import { z } from "zod";
import { route, json, body, requirePlatformOwner, E } from "@/lib/http";
import { setSetting, getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { platformOverview } from "@/lib/ops/platform";
import { applyOpsSchedules, isValidCron } from "@/lib/ops/schedules";
import { isIpv4, isIpv6 } from "@/lib/ops/public-ip";

/** Platform settings (owner only): GET overview, PATCH any subset of the editable keys. */
export const GET = route(async () => {
  await requirePlatformOwner();
  return json({ settings: await platformOverview() });
});

const nullableStr = z
  .string()
  .trim()
  .transform((s) => s || null)
  .nullable();

const schema = z
  .object({
    registration: z.enum(["open", "invite", "closed"]),
    serverIps: z.object({ ipv4: nullableStr, ipv6: nullableStr }),
    buildConcurrency: z.number().int().min(1).max(16),
    buildTimeoutMinutes: z.number().int().min(1).max(240),
    uploadMaxSizeMb: z.number().int().min(1).max(2047),
    defaults: z.object({
      cpuLimit: z.number().positive().max(256).nullable(),
      memoryLimitMb: z.number().int().min(16).max(1_048_576).nullable(),
      maxReplicas: z.number().int().min(1).max(64),
    }),
    backups: z.object({ enabled: z.boolean(), schedule: z.string().trim(), keep: z.number().int().min(1).max(365) }),
    updateUrl: z.string().trim().url("Enter a valid URL").nullable().or(z.literal("").transform(() => null)),
  })
  .partial();

export const PATCH = route(async (req) => {
  const actor = await requirePlatformOwner();
  const input = await body(req, schema);
  const changed: string[] = [];

  if (input.serverIps) {
    const { ipv4, ipv6 } = input.serverIps;
    const fields: Record<string, string> = {};
    if (ipv4 && !isIpv4(ipv4)) fields["serverIps.ipv4"] = "Not a valid IPv4 address";
    if (ipv6 && !isIpv6(ipv6)) fields["serverIps.ipv6"] = "Not a valid IPv6 address";
    if (Object.keys(fields).length) throw E.validation(fields);
    const cur = await getSetting("platform.serverIps");
    await setSetting("platform.serverIps", { ipv4, ipv6, detectedAt: cur.detectedAt });
    changed.push("platform.serverIps");
  }
  if (input.backups && !isValidCron(input.backups.schedule)) throw E.validation({ "backups.schedule": "Use a 5-field cron expression, e.g. 23 3 * * *" });

  const simple: [unknown, () => Promise<unknown>, string][] = [
    [input.registration, () => setSetting("platform.registration", input.registration!), "platform.registration"],
    [input.buildConcurrency, () => setSetting("build.concurrency", input.buildConcurrency!), "build.concurrency"],
    [input.buildTimeoutMinutes, () => setSetting("build.timeoutMinutes", input.buildTimeoutMinutes!), "build.timeoutMinutes"],
    [input.uploadMaxSizeMb, () => setSetting("uploads.maxSizeMb", input.uploadMaxSizeMb!), "uploads.maxSizeMb"],
    [input.defaults, () => setSetting("limits.defaults", input.defaults!), "limits.defaults"],
    [input.updateUrl, () => setSetting("updates.checkUrl", input.updateUrl ?? null), "updates.checkUrl"],
  ];
  for (const [value, save, key] of simple) {
    if (value === undefined) continue;
    await save();
    changed.push(key);
  }
  if (input.backups) {
    await setSetting("backups.control", input.backups);
    changed.push("backups.control");
    await applyOpsSchedules();
  }

  if (changed.length) await audit({ action: "platform.settings_update", actor, targetType: "platform", meta: { keys: changed } });
  return json({ settings: await platformOverview() });
});
