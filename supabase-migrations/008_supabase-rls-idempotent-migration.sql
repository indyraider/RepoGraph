-- RepoGraph: Idempotent RLS Migration
-- Safe to run multiple times — drops existing policies before recreating.
-- Run AFTER: supabase-migration.sql, supabase-sync-migration.sql,
--            supabase-connections-migration.sql, supabase-temporal-migration.sql
-- Run INSTEAD OF: supabase-rls-migration.sql (supersedes it)

-- ═══════════════════════════════════════════════════════════════════
-- 1. ADD OWNERSHIP COLUMNS
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE user_connections
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 2. BACKFILL owner_id FROM EXISTING github_id DATA
-- ═══════════════════════════════════════════════════════════════════

UPDATE user_connections uc
SET owner_id = au.id
FROM auth.users au
WHERE au.raw_user_meta_data->>'provider_id' = uc.github_id::text
  AND uc.owner_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 3. DROP ALL EXISTING POLICIES (idempotent cleanup)
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'repositories', 'digest_jobs', 'file_contents', 'sync_events',
        'user_connections', 'commits', 'complexity_metrics', 'temporal_digest_jobs',
        'log_sources', 'deployments', 'runtime_logs'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- 4. ENABLE RLS ON ALL TABLES
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE digest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE complexity_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE temporal_digest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_logs ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════
-- 5. POLICIES — repositories (ownership anchor)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own repositories"
  ON repositories FOR SELECT USING (owner_id = auth.uid());
CREATE POLICY "Users can insert their own repositories"
  ON repositories FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Users can update their own repositories"
  ON repositories FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Users can delete their own repositories"
  ON repositories FOR DELETE USING (owner_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- 6. POLICIES — digest_jobs (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own digest jobs"
  ON digest_jobs FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert digest jobs for their repos"
  ON digest_jobs FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can update their own digest jobs"
  ON digest_jobs FOR UPDATE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own digest jobs"
  ON digest_jobs FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 7. POLICIES — file_contents (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own file contents"
  ON file_contents FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert file contents for their repos"
  ON file_contents FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can update their own file contents"
  ON file_contents FOR UPDATE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own file contents"
  ON file_contents FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 8. POLICIES — sync_events (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own sync events"
  ON sync_events FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert sync events for their repos"
  ON sync_events FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can update their own sync events"
  ON sync_events FOR UPDATE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own sync events"
  ON sync_events FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 9. POLICIES — user_connections (direct ownership)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own connections"
  ON user_connections FOR SELECT USING (owner_id = auth.uid());
CREATE POLICY "Users can insert their own connections"
  ON user_connections FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Users can update their own connections"
  ON user_connections FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Users can delete their own connections"
  ON user_connections FOR DELETE USING (owner_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- 10. POLICIES — commits (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own commits"
  ON commits FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert commits for their repos"
  ON commits FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own commits"
  ON commits FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 11. POLICIES — complexity_metrics (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own complexity metrics"
  ON complexity_metrics FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert complexity metrics for their repos"
  ON complexity_metrics FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own complexity metrics"
  ON complexity_metrics FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 12. POLICIES — temporal_digest_jobs (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own temporal digest jobs"
  ON temporal_digest_jobs FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert temporal digest jobs for their repos"
  ON temporal_digest_jobs FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can update their own temporal digest jobs"
  ON temporal_digest_jobs FOR UPDATE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own temporal digest jobs"
  ON temporal_digest_jobs FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 13. POLICIES — log_sources (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own log sources"
  ON log_sources FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert log sources for their repos"
  ON log_sources FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can update their own log sources"
  ON log_sources FOR UPDATE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own log sources"
  ON log_sources FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 14. POLICIES — deployments (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own deployments"
  ON deployments FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert deployments for their repos"
  ON deployments FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can update their own deployments"
  ON deployments FOR UPDATE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own deployments"
  ON deployments FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 15. POLICIES — runtime_logs (via repo_id)
-- ═══════════════════════════════════════════════════════════════════

CREATE POLICY "Users can view their own runtime logs"
  ON runtime_logs FOR SELECT USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can insert runtime logs for their repos"
  ON runtime_logs FOR INSERT WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
CREATE POLICY "Users can delete their own runtime logs"
  ON runtime_logs FOR DELETE USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 16. UPDATE search_files RPC TO RESPECT RLS
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION search_files(
  search_query TEXT, result_limit INTEGER DEFAULT 10, lang_filter TEXT DEFAULT NULL
) RETURNS TABLE (file_path TEXT, language TEXT, size_bytes INTEGER, rank REAL) AS $$
BEGIN
  RETURN QUERY
  SELECT fc.file_path, fc.language, fc.size_bytes,
    ts_rank(fc.content_tsv, websearch_to_tsquery('english', search_query))::REAL AS rank
  FROM file_contents fc JOIN repositories r ON r.id = fc.repo_id
  WHERE fc.content_tsv @@ websearch_to_tsquery('english', search_query)
    AND r.owner_id = auth.uid()
    AND (lang_filter IS NULL OR fc.language = lang_filter)
  ORDER BY rank DESC LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════
-- 17. INDEXES FOR RLS PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories (owner_id);
CREATE INDEX IF NOT EXISTS idx_user_connections_owner ON user_connections (owner_id);
