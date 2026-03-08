/**
 * Railway OAuth2 Routes — handles the authorization code flow for Railway.
 *
 * Flow:
 * 1. Frontend opens popup to GET /api/auth/railway/connect
 * 2. Backend redirects to Railway's authorization endpoint
 * 3. Railway redirects back to GET /api/auth/railway/callback with ?code=
 * 4. Backend exchanges code for tokens, encrypts and stores them
 * 5. Callback page sends postMessage to opener and closes
 *
 * Endpoints (mounted at /api/railway-oauth):
 * - GET  /connect     — initiate OAuth flow
 * - GET  /callback    — handle Railway redirect (no auth required)
 * - GET  /status      — check if user has a stored token
 * - DELETE /disconnect — remove stored token
 */

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { config } from "./config.js";
import { encrypt, safeDecrypt } from "./lib/crypto.js";
import { getSupabase } from "./db/supabase.js";

const router = Router();

/** Resolve user ID from Bearer token (header) or ?token= query param. */
async function resolveUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) :
    typeof req.query.token === "string" ? req.query.token :
    null;
  if (!token) return null;

  try {
    const sb = getSupabase();
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  } catch {
    return null;
  }
}

const RAILWAY_AUTH_URL = "https://backboard.railway.com/oauth/auth";
const RAILWAY_TOKEN_URL = "https://backboard.railway.com/oauth/token";
const RAILWAY_USERINFO_URL = "https://backboard.railway.com/oauth/me";

function getRedirectUri(): string {
  // Backend URL for the callback — derive from FRONTEND_URL or use explicit override
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${config.port}`;
  return `${backendUrl}/api/railway-oauth/callback`;
}

// Persist OAuth state in Supabase so it survives backend restarts/deploys
async function storeOAuthState(state: string, userId: string): Promise<void> {
  const sb = getSupabase();
  await sb.from("oauth_states").upsert({
    state,
    user_id: userId,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
}

async function consumeOAuthState(state: string): Promise<string | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("oauth_states")
    .select("user_id, expires_at")
    .eq("state", state)
    .maybeSingle();

  if (error || !data) return null;

  // Delete the state regardless (one-time use)
  await sb.from("oauth_states").delete().eq("state", state);

  // Check expiry
  if (new Date(data.expires_at) < new Date()) return null;
  return data.user_id;
}

// GET /connect — redirect to Railway OAuth (accepts ?token= for auth since this is a browser redirect)
router.get("/connect", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (!config.railwayClientId) {
    res.status(500).json({ error: "Railway OAuth not configured (missing RAILWAY_OAUTH_CLIENT_ID)" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  await storeOAuthState(state, userId);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.railwayClientId,
    redirect_uri: getRedirectUri(),
    scope: "openid profile",
    state,
  });

  res.redirect(`${RAILWAY_AUTH_URL}?${params}`);
});

// GET /callback — exchange code for tokens (no auth required — user identified via state)
router.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return sendCallbackPage(res, false, String(oauthError));
  }

  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    return sendCallbackPage(res, false, "Missing authorization code or state");
  }

  // Validate CSRF state and retrieve user ID (stored in Supabase)
  const userId = await consumeOAuthState(state);
  if (!userId) {
    return sendCallbackPage(res, false, "Invalid or expired state parameter");
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch(RAILWAY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.railwayClientId,
        client_secret: config.railwayClientSecret,
        code,
        redirect_uri: getRedirectUri(),
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("[railway-oauth] Token exchange failed:", tokenRes.status, text);
      return sendCallbackPage(res, false, "Token exchange failed");
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    };

    // Fetch Railway user info for display
    let railwayUserName: string | null = null;
    try {
      const meRes = await fetch(RAILWAY_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (meRes.ok) {
        const me = await meRes.json() as { name?: string; email?: string };
        railwayUserName = me.name || me.email || null;
      }
    } catch {
      // Non-critical — continue without username
    }

    // Calculate expiry
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Upsert token into oauth_tokens table (service client to bypass RLS for upsert)
    const sb = getSupabase();
    const { error: dbError } = await sb
      .from("oauth_tokens")
      .upsert(
        {
          user_id: userId,
          provider: "railway",
          access_token_encrypted: encrypt(tokens.access_token),
          refresh_token_encrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
          expires_at: expiresAt,
          provider_user_name: railwayUserName,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

    if (dbError) {
      console.error("[railway-oauth] DB upsert failed:", dbError.message);
      return sendCallbackPage(res, false, "Failed to store token");
    }

    return sendCallbackPage(res, true, undefined, railwayUserName);
  } catch (err) {
    console.error("[railway-oauth] Callback error:", err);
    return sendCallbackPage(res, false, "OAuth callback failed");
  }
});

// GET /status — check if user has a stored Railway token
router.get("/status", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("oauth_tokens")
    .select("provider_user_name, expires_at, updated_at")
    .eq("user_id", userId)
    .eq("provider", "railway")
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (!data) {
    res.json({ connected: false });
    return;
  }

  const expired = data.expires_at && new Date(data.expires_at) < new Date();
  res.json({
    connected: true,
    userName: data.provider_user_name,
    expired: !!expired,
    connectedAt: data.updated_at,
  });
});

// DELETE /disconnect — remove stored Railway token
router.delete("/disconnect", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const sb = getSupabase();
  await sb
    .from("oauth_tokens")
    .delete()
    .eq("user_id", userId)
    .eq("provider", "railway");

  res.json({ ok: true });
});

// GET /projects — list Railway projects and their services using OAuth token
router.get("/projects", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const token = await getRailwayToken(userId);
  if (!token) {
    res.status(400).json({ error: "No Railway OAuth token found" });
    return;
  }

  try {
    // Railway uses a GraphQL API
    const gqlRes = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `query {
          me {
            projects(first: 50) {
              edges {
                node {
                  id
                  name
                  services {
                    edges {
                      node {
                        id
                        name
                      }
                    }
                  }
                  environments {
                    edges {
                      node {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
      }),
    });

    if (!gqlRes.ok) {
      const text = await gqlRes.text();
      console.error("[railway-oauth] GraphQL query failed:", gqlRes.status, text);
      res.status(502).json({ error: "Failed to fetch Railway projects" });
      return;
    }

    const gql = await gqlRes.json() as {
      data?: {
        me?: {
          projects?: {
            edges?: Array<{
              node: {
                id: string;
                name: string;
                services?: { edges?: Array<{ node: { id: string; name: string } }> };
                environments?: { edges?: Array<{ node: { id: string; name: string } }> };
              };
            }>;
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (gql.errors?.length) {
      console.error("[railway-oauth] GraphQL errors:", gql.errors);
      res.status(502).json({ error: gql.errors[0].message });
      return;
    }

    const projects = (gql.data?.me?.projects?.edges || []).map((e) => ({
      id: e.node.id,
      name: e.node.name,
      services: (e.node.services?.edges || []).map((s) => ({
        id: s.node.id,
        name: s.node.name,
      })),
      environments: (e.node.environments?.edges || []).map((env) => ({
        id: env.node.id,
        name: env.node.name,
      })),
    }));

    res.json({ projects });
  } catch (err) {
    console.error("[railway-oauth] Projects fetch error:", err);
    res.status(500).json({ error: "Failed to fetch Railway projects" });
  }
});

/**
 * Helper: get a valid Railway access token for a user, refreshing if expired.
 * Used by log source routes when creating sources with OAuth instead of manual tokens.
 */
export async function getRailwayToken(userId: string): Promise<string | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("oauth_tokens")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at")
    .eq("user_id", userId)
    .eq("provider", "railway")
    .maybeSingle();

  if (error || !data) return null;

  const accessToken = safeDecrypt(data.access_token_encrypted);
  if (!accessToken) return null;

  // Check if token is expired and we have a refresh token
  const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
  if (!isExpired) return accessToken;

  const refreshToken = data.refresh_token_encrypted
    ? safeDecrypt(data.refresh_token_encrypted)
    : null;
  if (!refreshToken) return accessToken; // Return possibly-expired token, let Railway reject it

  // Attempt refresh
  try {
    const refreshRes = await fetch(RAILWAY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.railwayClientId,
        client_secret: config.railwayClientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!refreshRes.ok) return accessToken; // Fallback to existing token

    const tokens = await refreshRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    await sb
      .from("oauth_tokens")
      .update({
        access_token_encrypted: encrypt(tokens.access_token),
        refresh_token_encrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("provider", "railway");

    return tokens.access_token;
  } catch {
    return accessToken; // Fallback to existing token on refresh failure
  }
}

/** Send a small HTML page that posts a message to the opener window and closes. */
function sendCallbackPage(
  res: Response,
  success: boolean,
  error?: string,
  userName?: string | null
) {
  const payload = JSON.stringify({ type: "railway-oauth", success, error, userName });
  res.send(`<!DOCTYPE html>
<html><head><title>Railway OAuth</title></head>
<body>
<script>
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify(payload)}, "*");
  }
  window.close();
</script>
<p>${success ? "Connected! This window will close." : `Error: ${error || "Unknown error"}`}</p>
</body></html>`);
}

export default router;
