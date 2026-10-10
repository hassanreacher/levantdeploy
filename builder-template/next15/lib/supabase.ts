import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase-compatible backend (LevantBase). The URL and anon key come from the environment
 * (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY) — they are set automatically when a backend is attached.
 * Everything here is safe to call when the backend is not configured yet: `getSupabase()` returns null.
 * Server-side (Server Components, Route Handlers, Server Actions): use `createServerSupabase()` from "@/lib/supabase-server".
 */
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

let browserClient: SupabaseClient | null = null;

/** Browser client (singleton). Returns null when the backend isn't configured. */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (typeof window === "undefined") return createBrowserClient(supabaseUrl, supabaseAnonKey);
  browserClient ??= createBrowserClient(supabaseUrl, supabaseAnonKey);
  return browserClient;
}

/** Like getSupabase() but throws a helpful error when the backend isn't configured. */
export function requireSupabase(): SupabaseClient {
  const client = getSupabase();
  if (!client) throw new Error("Backend not connected: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (attach a LevantBase backend).");
  return client;
}
