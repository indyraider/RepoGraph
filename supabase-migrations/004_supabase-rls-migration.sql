-- RepoGraph: Row Level Security Migration
-- Migrates all tables to use Supabase Auth (auth.uid()) for ownership enforcement.
-- Run AFTER enabling GitHub provider in Supabase Dashboard > Authentication > Providers.
--
-- Prerequisites:
--   - supabase-migration.sql (repositories, digest_jobs, file_contents)
--   - supabase-sync-migration.sql (sync_events)
--   - supabase-connections-migration.sql (user_connections)

-- ═══════════════════════════════════════════════════════════════════
-- 1. ADD OWNERSHIP COLUMNS
-- ═══════════════════════════════════════════════════════════════════

-- Primary ownership anchor: repositories belong to a Supabase Auth user
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Migrate user_connections from github_id to owner_id
-- (keep github_id temporarily for data migration, drop after backfill)
ALTER TABLE user_connections
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 2. BACKFILL owner_id FROM EXISTING github_id DATA
-- ═══════════════════════════════════════════════════════════════════

-- Supabase Auth stores GitHub identity in raw_user_meta_data->>'provider_id'
-- This backfills owner_id for existing user_connections rows
UPDATE user_connections uc
SET owner_id = au.id
FROM auth.users au
WHERE au.raw_user_meta_data->>'provider_id' = uc.github_id::text
  AND uc.owner_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 3. ENABLE ROW LEVEL SECURITY ON ALL TABLES
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE digest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_connections ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════
-- 4. RLS POLICIES — repositories (ownership anchor)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own repositories"
  ON repositories FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Users can insert their own repositories"
  ON repositories FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users can update their own repositories"
  ON repositories FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users can delete their own repositories"
  ON repositories FOR DELETE
  USING (owner_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- 5. RLS POLICIES — child tables (ownership via repo_id FK)
-- ═══════════════════════════════════════════════════════════════════

-- digest_jobs
CREATE POLICY "Users can view their own digest jobs"
  ON digest_jobs FOR SELECT
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can insert digest jobs for their repos"
  ON digest_jobs FOR INSERT
  WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can update their own digest jobs"
  ON digest_jobs FOR UPDATE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can delete their own digest jobs"
  ON digest_jobs FOR DELETE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- file_contents
CREATE POLICY "Users can view their own file contents"
  ON file_contents FOR SELECT
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can insert file contents for their repos"
  ON file_contents FOR INSERT
  WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can update their own file contents"
  ON file_contents FOR UPDATE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can delete their own file contents"
  ON file_contents FOR DELETE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- sync_events
CREATE POLICY "Users can view their own sync events"
  ON sync_events FOR SELECT
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can insert sync events for their repos"
  ON sync_events FOR INSERT
  WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can update their own sync events"
  ON sync_events FOR UPDATE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can delete their own sync events"
  ON sync_events FOR DELETE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 6. RLS POLICIES — user_connections (direct ownership)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own connections"
  ON user_connections FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Users can insert their own connections"
  ON user_connections FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users can update their own connections"
  ON user_connections FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users can delete their own connections"
  ON user_connections FOR DELETE
  USING (owner_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- 7. UPDATE search_files RPC TO RESPECT RLS
-- ═══════════════════════════════════════════════════════════════════

-- Replace the existing function with one that filters by auth.uid()
CREATE OR REPLACE FUNCTION search_files(
  search_query TEXT,
  result_limit INTEGER DEFAULT 10,
  lang_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
  file_path TEXT,
  language TEXT,
  size_bytes INTEGER,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    fc.file_path,
    fc.language,
    fc.size_bytes,
    ts_rank(fc.content_tsv, websearch_to_tsquery('english', search_query))::REAL AS rank
  FROM file_contents fc
  JOIN repositories r ON r.id = fc.repo_id
  WHERE fc.content_tsv @@ websearch_to_tsquery('english', search_query)
    AND r.owner_id = auth.uid()
    AND (lang_filter IS NULL OR fc.language = lang_filter)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════
-- 8. INDEX FOR RLS POLICY PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories (owner_id);
CREATE INDEX IF NOT EXISTS idx_user_connections_owner ON user_connections (owner_id);

-- ═══════════════════════════════════════════════════════════════════
-- 9. CLEANUP (run after confirming backfill is complete)
-- ═══════════════════════════════════════════════════════════════════

-- Uncomment after verifying all user_connections rows have owner_id set:
-- ALTER TABLE user_connections DROP COLUMN github_id;
-- ALTER TABLE user_connections ADD CONSTRAINT user_connections_owner_provider_label_unique
--   UNIQUE(owner_id, provider, label);
