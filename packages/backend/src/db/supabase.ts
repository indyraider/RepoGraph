import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { config } from "../config.js";
import type { AuthenticatedUser } from "../auth.js";

let serviceClient: SupabaseClient;

/** Service-role client — bypasses RLS. Use for admin/background operations only. */
export function getSupabase(): SupabaseClient {
  if (!serviceClient) {
    if (!config.supabase.url || !config.supabase.key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env");
    }
    serviceClient = createClient(config.supabase.url, config.supabase.key);
  }
  return serviceClient;
}

/**
 * Create a Supabase client scoped to a specific user's access token.
 * All queries through this client are subject to RLS policies.
 */
export function createUserClient(accessToken: string): SupabaseClient {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
  }
  return createClient(config.supabase.url, config.supabase.anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

/** Extract the authenticated user from the request (set by auth middleware). */
export function getUser(req: Request): AuthenticatedUser | null {
  return (req as any).user || null;
}

/**
 * Get a user-scoped Supabase client (RLS enforced).
 * Throws if no authenticated user is present — never falls back to service role.
 */
export function getUserDb(req: Request): SupabaseClient {
  const user = getUser(req);
  if (!user) {
    throw new Error("Authentication required");
  }
  return createUserClient(user.accessToken);
}

export async function verifySupabaseConnection(): Promise<boolean> {
  try {
    const sb = getSupabase();
    const { error } = await sb.from("repositories").select("id").limit(1);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("Supabase connection failed:", err);
    return false;
  }
}
