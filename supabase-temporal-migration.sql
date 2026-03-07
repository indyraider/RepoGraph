-- Temporal Graph — Supabase Migration
-- Phase 6 of RepoGraph: code evolution over time
-- Run after: supabase-migration.sql

-- ─── Commits ────────────────────────────────────────────────────
-- Git commit metadata for temporal attribution

CREATE TABLE IF NOT EXISTS commits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha           TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_email  TEXT,
  timestamp     TIMESTAMPTZ NOT NULL,
  message       TEXT,
  parent_shas   TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits (repo_id);
CREATE INDEX IF NOT EXISTS idx_commits_repo_ts ON commits (repo_id, timestamp DESC);

-- ─── Complexity Metrics ─────────────────────────────────────────
-- Per-file structural metrics at each commit (time-series data)

CREATE TABLE IF NOT EXISTS complexity_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha    TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  metric_name   TEXT NOT NULL,     -- import_count, reverse_import_count, symbol_count, coupling_score, churn_rate
  metric_value  REAL NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complexity_repo_file ON complexity_metrics (repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_complexity_repo_ts ON complexity_metrics (repo_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_complexity_repo_metric ON complexity_metrics (repo_id, metric_name, file_path);

-- ─── Temporal Digest Jobs ───────────────────────────────────────
-- Track progress of temporal/backfill digest operations

CREATE TABLE IF NOT EXISTS temporal_digest_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id           UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  digest_job_id     UUID REFERENCES digest_jobs(id) ON DELETE SET NULL,
  mode              TEXT NOT NULL DEFAULT 'snapshot',  -- snapshot, historical, incremental
  commits_processed INTEGER NOT NULL DEFAULT 0,
  commits_total     INTEGER NOT NULL DEFAULT 0,
  oldest_commit_sha TEXT,
  newest_commit_sha TEXT,
  stats             JSONB DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'running',   -- running, complete, failed
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  error_log         TEXT
);

CREATE INDEX IF NOT EXISTS idx_temporal_jobs_repo ON temporal_digest_jobs (repo_id);

-- ─── RLS ────────────────────────────────────────────────────────
-- Disable RLS for single-user local tool (matching existing pattern)

ALTER TABLE commits DISABLE ROW LEVEL SECURITY;
ALTER TABLE complexity_metrics DISABLE ROW LEVEL SECURITY;
ALTER TABLE temporal_digest_jobs DISABLE ROW LEVEL SECURITY;
