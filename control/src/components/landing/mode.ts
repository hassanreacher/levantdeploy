import "server-only";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { getUser } from "@/lib/auth/session";
import type { RegistrationMode } from "./site-chrome";

/** setup = no account yet (first one becomes owner) · open = public sign-up · invite = invitation only. Never throws. */
export async function getRegistrationMode(): Promise<RegistrationMode> {
  const [users, registration] = await Promise.all([db.user.count().catch(() => 1), getSetting("platform.registration").catch(() => "invite" as const)]);
  return users === 0 ? "setup" : process.env.REGISTRATION === "open" || registration === "open" ? "open" : "invite";
}

/** For the public marketing pages' header (they are reachable signed in, too). */
export async function marketingContext() {
  const [mode, user] = await Promise.all([getRegistrationMode(), getUser().catch(() => null)]);
  return { mode, signedIn: !!user };
}
