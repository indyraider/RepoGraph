-- Runtime Context Layer — Supabase Migration
-- Phase 5 of RepoGraph: live log ingestion + code graph bridging
-- Run after: supabase-migration.sql, supabase-sync-migration.sql, supabase-connections-migration.sql

-- ─── Log Sources ─────────────────────────────────────────────────
-- Configuration for each connected log platform (Vercel, Railway, etc.)

CREATE TABLE IF NOT EXISTS log_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,                          -- adapter identifier: "vercel", "railway"
  display_name  TEXT NOT NULL,                          -- user-defined label
  config        JSONB NOT NULL DEFAULT '{}',            -- adapter-specific config + encrypted_api_token
  polling_interval_sec INTEGER NOT NULL DEFAULT 30,
  min_level     TEXT NOT NULL DEFAULT 'warn',           -- minimum log level to store: info, warn, error
  enabled       BOOLEAN NOT NULL DEFAULT true,
  last_poll_at  TIMESTAMPTZ,
  last_error    TEXT,                                   -- last collector error (cleared on success)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Deployments ─────────────────────────────────────────────────
-- Deployment/CI run records from connected platforms

CREATE TABLE IF NOT EXISTS deployments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,                          -- adapter platform identifier
  deployment_id TEXT NOT NULL,                          -- platform-native deployment/run ID
  status        TEXT,                                   -- ready, error, building, cancelled, running
  branch        TEXT,
  commit_sha    TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  url           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(repo_id, deployment_id, source)
);

-- ─── Runtime Logs ────────────────────────────────────────────────
-- Normalized log entries from all connected platforms

CREATE TABLE IF NOT EXISTS runtime_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,                          -- adapter platform identifier
  level         TEXT NOT NULL,                          -- info, warn, error
  message       TEXT NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL,                   -- log event time (from platform)
  deployment_id TEXT,                                   -- platform-specific deployment/run ID
  function_name TEXT,                                   -- serverless function, service, or job name
  file_path     TEXT,                                   -- parsed from stack trace
  line_number   INTEGER,                                -- parsed from stack trace
  stack_trace   TEXT,                                   -- full raw stack trace
  metadata      JSONB NOT NULL DEFAULT '{}'             -- platform-specific extras
);

-- ─── Indexes ─────────────────────────────────────────────────────

-- Primary sort for get_recent_logs
CREATE INDEX IF NOT EXISTS idx_runtime_logs_timestamp
  ON runtime_logs (timestamp DESC);

-- Filtered queries by level
CREATE INDEX IF NOT EXISTS idx_runtime_logs_level_timestamp
  ON runtime_logs (level, timestamp DESC);

-- Per-platform queries
CREATE INDEX IF NOT EXISTS idx_runtime_logs_source_timestamp
  ON runtime_logs (source, timestamp DESC);

-- Join with deployments table
CREATE INDEX IF NOT EXISTS idx_runtime_logs_deployment
  ON runtime_logs (deployment_id, source);

-- Per-repo queries (needed for MCP tools filtering by repo)
CREATE INDEX IF NOT EXISTS idx_runtime_logs_repo_timestamp
  ON runtime_logs (repo_id, timestamp DESC);

-- Full-text search for search_logs
CREATE INDEX IF NOT EXISTS idx_runtime_logs_message_fts
  ON runtime_logs USING GIN(to_tsvector('english', message));

-- Deployment history ordering
CREATE INDEX IF NOT EXISTS idx_deployments_started_at
  ON deployments (started_at DESC);

-- Deployment lookup by repo
CREATE INDEX IF NOT EXISTS idx_deployments_repo_started
  ON deployments (repo_id, started_at DESC);

-- Log sources by repo
CREATE INDEX IF NOT EXISTS idx_log_sources_repo
  ON log_sources (repo_id);
