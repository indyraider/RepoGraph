-- RepoGraph Supabase Schema Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)

-- 1. Repositories table
CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  commit_sha TEXT,
  last_digest_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'idle',
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Digest jobs table
CREATE TABLE IF NOT EXISTS digest_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',
  stage TEXT NOT NULL DEFAULT 'cloning',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_log TEXT,
  stats JSONB DEFAULT '{}'
);

-- 3. File contents table
CREATE TABLE IF NOT EXISTS file_contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content TEXT,
  content_hash TEXT,
  language TEXT,
  size_bytes INTEGER,
  UNIQUE(repo_id, file_path)
);

-- 4. Full-text search: generated tsvector column + GIN index
ALTER TABLE file_contents
  ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_file_contents_tsv ON file_contents USING GIN (content_tsv);

-- 5. Additional indexes
CREATE INDEX IF NOT EXISTS idx_file_contents_repo ON file_contents (repo_id);
CREATE INDEX IF NOT EXISTS idx_digest_jobs_repo ON digest_jobs (repo_id);

-- 6. Full-text search RPC function (used by MCP server search_code tool)
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
  WHERE fc.content_tsv @@ websearch_to_tsquery('english', search_query)
    AND (lang_filter IS NULL OR fc.language = lang_filter)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- 7. Disable RLS (single-user local tool)
ALTER TABLE repositories DISABLE ROW LEVEL SECURITY;
ALTER TABLE digest_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE file_contents DISABLE ROW LEVEL SECURITY;
