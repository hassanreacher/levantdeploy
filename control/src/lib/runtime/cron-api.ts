import { z } from "zod";
import type { CronJob } from "@prisma/client";
import { describeCron, isValidCron } from "./cron-expr";

const tzOk = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const base = {
  name: z.string().trim().min(1).max(80),
  schedule: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .superRefine((s, ctx) => {
      const e = isValidCron(s);
      if (e) ctx.addIssue({ code: "custom", message: e });
    }),
  timezone: z.string().trim().max(60).refine(tzOk, "Unknown timezone").default("UTC"),
  command: z.string().trim().max(2000).nullish(),
  path: z
    .string()
    .trim()
    .max(500)
    .regex(/^\/[^\s]*$/, "Path must start with /")
    .nullish(),
  enabled: z.boolean().default(true),
};

export const cronSchema = z.object(base).refine((v) => !!v.command !== !!v.path, { message: "Set either a command or a path", path: ["command"] });

export const cronUpdateSchema = z.object({
  name: base.name.optional(),
  schedule: base.schedule.optional(),
  timezone: z.string().trim().max(60).refine(tzOk, "Unknown timezone").optional(),
  command: base.command,
  path: base.path,
  enabled: z.boolean().optional(),
});

export function cronDTO(j: CronJob) {
  return {
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    description: describeCron(j.schedule),
    timezone: j.timezone,
    command: j.command,
    path: j.path,
    enabled: j.enabled,
    lastRunAt: j.lastRunAt?.toISOString() ?? null,
    lastStatus: j.lastStatus,
    lastDurationMs: j.lastDurationMs,
    nextRunAt: j.nextRunAt?.toISOString() ?? null,
    createdAt: j.createdAt.toISOString(),
  };
}
export type CronDTO = ReturnType<typeof cronDTO>;
