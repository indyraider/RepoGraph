import { Router } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

const router = Router();

export interface JwtPayload {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

const COOKIE_NAME = "repograph_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// GET /api/auth/github — redirect to GitHub authorize page
router.get("/github", (_req, res) => {
  if (!config.githubClientId) {
    res.status(500).json({ error: "GITHUB_CLIENT_ID not configured" });
    return;
  }
  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: `${getBackendUrl()}/api/auth/callback`,
    scope: "read:user",
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// GET /api/auth/callback — exchange code for token, set cookie, redirect to frontend
router.get("/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.redirect(`${config.frontendUrl}/login?error=no_code`);
    return;
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
      console.error("[auth] Token exchange failed:", tokenData.error);
      res.redirect(`${config.frontendUrl}/login?error=token_exchange_failed`);
      return;
    }

    // Fetch user profile
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });
    const user = await userRes.json() as {
      id: number;
      login: string;
      name: string | null;
      avatar_url: string;
    };

    if (!user.id) {
      console.error("[auth] Failed to fetch user profile");
      res.redirect(`${config.frontendUrl}/login?error=user_fetch_failed`);
      return;
    }

    // Sign JWT
    const payload: JwtPayload = {
      githubId: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
    };

    const token = jwt.sign(payload, config.sessionSecret, { expiresIn: "7d" });

    // Set cookie and redirect to frontend
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    res.redirect(`${config.frontendUrl}/dashboard`);
  } catch (err) {
    console.error("[auth] OAuth callback error:", err);
    res.redirect(`${config.frontendUrl}/login?error=auth_failed`);
  }
});

// GET /api/auth/me — return current user from JWT cookie
router.get("/me", (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.sessionSecret) as JwtPayload;
    res.json({
      id: payload.githubId,
      login: payload.login,
      name: payload.name,
      avatar_url: payload.avatarUrl,
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
});

// POST /api/auth/logout — clear cookie
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
  res.json({ ok: true });
});

// Helper: derive backend URL for redirect_uri
function getBackendUrl(): string {
  // In production, use the request origin or a configured URL
  // For now, derive from FRONTEND_URL pattern or use explicit config
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `http://localhost:${config.port}`;
}

export default router;
export { COOKIE_NAME };
