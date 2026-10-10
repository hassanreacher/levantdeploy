import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client bound to the request cookies (auth sessions work across SSR).
 * Uses SUPABASE_URL (internal URL on the platform network) when set, otherwise the public URL.
 * Returns null when the backend isn't configured.
 */
export async function createServerSupabase(): Promise<SupabaseClient | null> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a Server Component: cookies are read-only there (middleware/route handlers refresh them)
        }
      },
    },
  });
}
