import { redis } from "@/lib/redis";
import { decryptJson, encryptJson, randomId } from "@/lib/crypto";
import { generateDeployKey } from "./deploy-keys";

/**
 * Deploy keys generated during the import flow, before the project exists (the user first adds the public key
 * to the repository). Kept encrypted in Redis for 2 hours, then claimed by project creation.
 */
type Pending = { publicKey: string; privateKey: string; fingerprint: string; teamId: string };
const key = (id: string) => `ld:git:pendingkey:${id}`;

export async function createPendingKey(teamId: string, comment: string) {
  const k = generateDeployKey(comment);
  const id = "dk_" + randomId(16);
  await redis().set(key(id), encryptJson({ ...k, teamId } satisfies Pending), "EX", 7200);
  return { id, publicKey: k.publicKey, fingerprint: k.fingerprint };
}

export async function readPendingKey(id: string, teamId: string): Promise<Pending | null> {
  if (!/^dk_[a-z0-9]{16}$/.test(id)) return null;
  const v = decryptJson<Pending>(await redis().get(key(id)));
  return v && v.teamId === teamId ? v : null;
}

export async function dropPendingKey(id: string) {
  await redis().del(key(id));
}
