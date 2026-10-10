import crypto from "node:crypto";
import { redis } from "@/lib/redis";
import { decryptString, encryptString, randomToken, sha256 } from "@/lib/crypto";
import { createApiToken } from "@/lib/auth/tokens";

/**
 * Device-code login for the `levant` CLI.
 *  1. CLI: POST /api/v1/cli/login → { deviceCode (secret), userCode "ABCD-EFGH", verificationUrl, interval, expiresIn }
 *  2. CLI opens {APP_URL}/cli/authorize?code=ABCD-EFGH; the signed-in user approves (creates an API token)
 *  3. CLI polls POST /api/v1/cli/login/poll { deviceCode } → { status: "pending" } … { status: "approved", token, user }
 * State lives in Redis for 10 minutes; the token is handed out once.
 */
export const DEVICE_TTL = 600;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"; // no vowels / ambiguous chars

export type DeviceState = {
  userCode: string;
  status: "pending" | "approved" | "denied";
  clientName: string;
  hostname: string | null;
  ip: string | null;
  createdAt: number;
  tokenEnc?: string;
  userId?: string;
  teamSlug?: string | null;
};

const devKey = (deviceCode: string) => `ld:cli:dev:${sha256(deviceCode)}`;
const codeKey = (userCode: string) => `ld:cli:code:${userCode}`;

export function newUserCode(): string {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i]! % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normalizeUserCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

export async function startDeviceLogin(input: { clientName?: string; hostname?: string | null; ip?: string | null }) {
  const deviceCode = randomToken(32);
  let userCode = newUserCode();
  const r = redis();
  for (let i = 0; i < 5 && (await r.exists(codeKey(userCode))); i++) userCode = newUserCode();
  const st: DeviceState = {
    userCode,
    status: "pending",
    clientName: (input.clientName || "levant CLI").slice(0, 60),
    hostname: input.hostname?.slice(0, 100) ?? null,
    ip: input.ip ?? null,
    createdAt: Date.now(),
  };
  await r.set(devKey(deviceCode), JSON.stringify(st), "EX", DEVICE_TTL);
  await r.set(codeKey(userCode), sha256(deviceCode), "EX", DEVICE_TTL);
  return { deviceCode, userCode };
}

async function loadByUserCode(userCode: string): Promise<{ key: string; st: DeviceState } | null> {
  const h = await redis().get(codeKey(normalizeUserCode(userCode)));
  if (!h) return null;
  const key = `ld:cli:dev:${h}`;
  const raw = await redis().get(key);
  return raw ? { key, st: JSON.parse(raw) as DeviceState } : null;
}

export async function describeUserCode(userCode: string) {
  const x = await loadByUserCode(userCode);
  return x ? { userCode: x.st.userCode, status: x.st.status, clientName: x.st.clientName, hostname: x.st.hostname, ip: x.st.ip, createdAt: x.st.createdAt } : null;
}

export async function decideUserCode(userCode: string, decision: "approve" | "deny", user: { id: string }, opts: { teamId?: string | null; teamSlug?: string | null } = {}) {
  const x = await loadByUserCode(userCode);
  if (!x) return null;
  if (x.st.status !== "pending") return x.st.status;
  const ttl = Math.max(await redis().ttl(x.key), 30);
  if (decision === "deny") {
    x.st.status = "denied";
  } else {
    const { token } = await createApiToken({
      userId: user.id,
      teamId: opts.teamId ?? null,
      name: `CLI${x.st.hostname ? ` on ${x.st.hostname}` : ""}`.slice(0, 60),
      scopes: ["*"],
      expiresAt: new Date(Date.now() + 365 * 86400_000),
    });
    x.st.status = "approved";
    x.st.tokenEnc = encryptString(token);
    x.st.userId = user.id;
    x.st.teamSlug = opts.teamSlug ?? null;
  }
  await redis().set(x.key, JSON.stringify(x.st), "EX", ttl);
  await redis().del(codeKey(x.st.userCode));
  return x.st.status;
}

/** One-shot: returns the token once, then forgets the device. */
export async function pollDeviceLogin(deviceCode: string): Promise<{ status: "pending" | "denied" | "expired" } | { status: "approved"; token: string; userId: string; teamSlug: string | null }> {
  const key = devKey(deviceCode);
  const raw = await redis().get(key);
  if (!raw) return { status: "expired" };
  const st = JSON.parse(raw) as DeviceState;
  if (st.status === "pending") return { status: "pending" };
  await redis().del(key);
  if (st.status === "denied") return { status: "denied" };
  const token = decryptString(st.tokenEnc);
  if (!token) return { status: "expired" };
  return { status: "approved", token, userId: st.userId!, teamSlug: st.teamSlug ?? null };
}
