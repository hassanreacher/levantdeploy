import { z } from "zod";
import type { Volume } from "@prisma/client";
import { docker } from "@/lib/docker";
import { volumeDockerName } from "./containers";

const RESERVED_MOUNTS = ["/", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/tmp"];

export const volumeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, - and _"),
  mountPath: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .regex(/^\/[A-Za-z0-9._/-]+$/, "Absolute path like /app/data")
    .refine((p) => !p.includes("..") && !RESERVED_MOUNTS.includes(p.replace(/\/+$/, "") || "/"), "This path can't be used as a mount point")
    .transform((p) => p.replace(/\/+$/, "")),
  sizeHint: z.string().trim().max(20).nullish(),
});

/** Volume + live docker info (exists, size when docker reports it). */
export async function volumeDTO(v: Volume) {
  const name = v.dockerName || volumeDockerName(v.projectId, v.name);
  let exists = false;
  let createdAt: string | null = null;
  try {
    const info = await docker().getVolume(name).inspect();
    exists = true;
    createdAt = (info as unknown as { CreatedAt?: string }).CreatedAt ?? null;
  } catch {}
  return {
    id: v.id,
    name: v.name,
    mountPath: v.mountPath,
    sizeHint: v.sizeHint,
    dockerName: name,
    exists,
    dockerCreatedAt: createdAt,
    createdAt: v.createdAt.toISOString(),
  };
}
