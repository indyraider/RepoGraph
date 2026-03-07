-- Railway OAuth tokens — stores per-user Railway OAuth credentials
-- so users can connect log sources without manually pasting API tokens.

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'railway',
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  expires_at TIMESTAMPTZ,
  provider_user_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

-- RLS: users can only see/manage their own tokens
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_tokens_select ON oauth_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY oauth_tokens_insert ON oauth_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY oauth_tokens_update ON oauth_tokens
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY oauth_tokens_delete ON oauth_tokens
  FOR DELETE USING (auth.uid() = user_id);

-- Allow service role full access (for backend token refresh)
CREATE POLICY oauth_tokens_service ON oauth_tokens
  FOR ALL USING (auth.role() = 'service_role');
