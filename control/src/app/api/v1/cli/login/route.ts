import { z } from "zod";
import { route, json, body, clientIp } from "@/lib/http";
import { appUrl } from "@/lib/env";
import { startDeviceLogin, DEVICE_TTL } from "@/lib/git/cli-auth";

export const dynamic = "force-dynamic";

/** POST /api/v1/cli/login { clientName?, hostname? } → { deviceCode, userCode, verificationUrl, interval, expiresIn } (no auth) */
export const POST = route(
  async (req) => {
    const input = await body(req, z.object({ clientName: z.string().max(60).optional(), hostname: z.string().max(100).optional() }));
    const { deviceCode, userCode } = await startDeviceLogin({ ...input, ip: await clientIp() });
    return json({ deviceCode, userCode, verificationUrl: appUrl(`/cli/authorize?code=${userCode}`), interval: 2, expiresIn: DEVICE_TTL }, 201);
  },
  { limit: { limit: 10, window: 60 }, key: "cli-login" },
);
