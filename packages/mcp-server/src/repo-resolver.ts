/**
 * Repo Resolver — resolves a repo name or URL to a Supabase UUID.
 * Used by all 5 runtime MCP tools to map the user-facing repo identifier
 * to the repo_id foreign key used in runtime_logs, deployments, etc.
 */

import { SupabaseClient } from "@supabase/supabase-js";

export async function resolveRepoId(
  sb: SupabaseClient,
  repoNameOrUrl: string
): Promise<string | null> {
  // Try exact match on name first, then URL
  const { data } = await sb
    .from("repositories")
    .select("id")
    .or(`name.eq.${repoNameOrUrl},url.eq.${repoNameOrUrl}`)
    .limit(1)
    .single();

  return data?.id ?? null;
}
