-- Persistent OAuth CSRF state store (survives backend restarts/deploys)
-- Short-lived rows: cleaned up on consumption or expiry.

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No RLS needed — this table is only accessed by the backend service role.
-- The state values are cryptographically random and single-use.
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_states_service ON oauth_states
  FOR ALL USING (auth.role() = 'service_role');
