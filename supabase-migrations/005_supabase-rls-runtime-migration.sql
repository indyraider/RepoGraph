-- RepoGraph: RLS for Runtime Tables
-- Run AFTER supabase-runtime-migration.sql AND supabase-rls-migration.sql

-- ═══════════════════════════════════════════════════════════════════
-- 1. ENABLE RLS
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE log_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_logs ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════
-- 2. RLS POLICIES (ownership via repo_id → repositories.owner_id)
-- ═══════════════════════════════════════════════════════════════════

-- log_sources
CREATE POLICY "Users can view their own log sources"
  ON log_sources FOR SELECT
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can insert log sources for their repos"
  ON log_sources FOR INSERT
  WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can update their own log sources"
  ON log_sources FOR UPDATE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can delete their own log sources"
  ON log_sources FOR DELETE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- deployments
CREATE POLICY "Users can view their own deployments"
  ON deployments FOR SELECT
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can insert deployments for their repos"
  ON deployments FOR INSERT
  WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can update their own deployments"
  ON deployments FOR UPDATE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can delete their own deployments"
  ON deployments FOR DELETE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

-- runtime_logs
CREATE POLICY "Users can view their own runtime logs"
  ON runtime_logs FOR SELECT
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can insert runtime logs for their repos"
  ON runtime_logs FOR INSERT
  WITH CHECK (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));

CREATE POLICY "Users can delete their own runtime logs"
  ON runtime_logs FOR DELETE
  USING (repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid()));
