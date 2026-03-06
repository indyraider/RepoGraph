import { Router, type Request, type Response } from "express";
import { getSupabase } from "./db/supabase.js";

const router = Router();

export interface AuthenticatedUser {
  /** Supabase Auth user ID (UUID) */
  id: string;
  /** GitHub username */
  login: string;
  /** Display name */
  name: string | null;
  /** GitHub avatar URL */
  avatarUrl: string;
  /** GitHub user ID (numeric) */
  githubId: number;
  /** Supabase access token (for creating user-scoped DB clients) */
  accessToken: string;
}

// GET /api/auth/me — verify Supabase access token and return user info
router.get("/me", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const sb = getSupabase();
    const { data: { user }, error } = await sb.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const meta = user.user_metadata || {};
    res.json({
      id: user.id,
      github_id: meta.provider_id ? parseInt(meta.provider_id, 10) : null,
      login: meta.user_name || meta.preferred_username || "",
      name: meta.full_name || meta.name || null,
      avatar_url: meta.avatar_url || "",
    });
  } catch {
    res.status(401).json({ error: "Authentication failed" });
  }
});

export default router;
