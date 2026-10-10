import QRCode from "qrcode";
import { route, json, requireSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { generateTotpSecret, otpauthUri } from "@/lib/auth/totp";
import { encryptString } from "@/lib/crypto";

/** Step 1: generate a secret (stored encrypted, not active until /enable). */
export const POST = route(async () => {
  const s = await requireSession();
  if (s.user.totpEnabled) throw E.conflict("Two-factor authentication is already enabled");
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: s.user.id }, data: { totpSecret: encryptString(secret) } });
  const uri = otpauthUri(secret, s.user.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return json({ secret, uri, qr });
});
