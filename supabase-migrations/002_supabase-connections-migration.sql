-- RepoGraph: User Connections Migration
-- Stores per-user Neo4j and Supabase connection credentials.
-- Credentials are encrypted at the application layer before storage.

CREATE TABLE IF NOT EXISTS user_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id BIGINT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('neo4j', 'supabase')),
  label TEXT NOT NULL DEFAULT 'default',
  credentials JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(github_id, provider, label)
);

CREATE INDEX IF NOT EXISTS idx_user_connections_github ON user_connections (github_id);
