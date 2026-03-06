import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

let client: SupabaseClient;

export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!config.supabase.url || !config.supabase.key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env");
    }
    client = createClient(config.supabase.url, config.supabase.key);
  }
  return client;
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
