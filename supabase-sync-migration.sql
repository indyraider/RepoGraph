-- RepoGraph Continuous Sync Schema Migration
-- Run this in your Supabase SQL Editor AFTER the initial migration

-- 1. Add sync columns to repositories table
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS sync_mode TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS sync_config JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_synced_sha TEXT;

-- 2. Sync events table
CREATE TABLE IF NOT EXISTS sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,  -- 'webhook' | 'watcher' | 'manual'
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  files_changed INTEGER DEFAULT 0,
  files_added INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'success' | 'failed'
  error_log TEXT
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_sync_events_repo ON sync_events (repo_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_started ON sync_events (started_at DESC);

-- 4. Disable RLS
ALTER TABLE sync_events DISABLE ROW LEVEL SECURITY;
