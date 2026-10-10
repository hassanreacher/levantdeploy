import { route, json } from "@/lib/http";
import { destroySession, getSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

export const POST = route(async () => {
  const s = await getSession();
  await destroySession();
  if (s) await audit({ action: "user.logout", userId: s.user.id });
  return json({ ok: true, redirect: "/login" });
});
