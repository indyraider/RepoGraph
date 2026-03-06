import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";

export interface AuthUser {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string;
  github_id: number | null;
}

interface AuthState {
  status: "loading" | "authenticated" | "unauthenticated";
  user: AuthUser | null;
  /** Supabase access token for API calls */
  accessToken: string | null;
  /** GitHub provider token (for GitHub API calls like listing repos) */
  githubToken: string | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  status: "loading",
  user: null,
  accessToken: null,
  githubToken: null,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function sessionToUser(session: Session): AuthUser {
  const meta = session.user.user_metadata || {};
  return {
    id: session.user.id,
    login: meta.user_name || meta.preferred_username || "",
    name: meta.full_name || meta.name || null,
    avatar_url: meta.avatar_url || "",
    github_id: meta.provider_id ? parseInt(meta.provider_id, 10) : null,
  };
}

// Store GitHub provider token in sessionStorage so it survives page refreshes
// (Supabase Auth only provides it on initial sign-in)
const GH_TOKEN_KEY = "repograph_gh_token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [githubToken, setGithubToken] = useState<string | null>(
    () => sessionStorage.getItem(GH_TOKEN_KEY)
  );

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setUser(sessionToUser(session));
        setAccessToken(session.access_token);
        setStatus("authenticated");
      } else {
        setStatus("unauthenticated");
      }
    });

    // Listen for auth state changes (sign-in, sign-out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (session) {
          setUser(sessionToUser(session));
          setAccessToken(session.access_token);
          setStatus("authenticated");

          // Capture provider token on initial sign-in
          if (event === "SIGNED_IN" && session.provider_token) {
            setGithubToken(session.provider_token);
            sessionStorage.setItem(GH_TOKEN_KEY, session.provider_token);
          }
        } else {
          setUser(null);
          setAccessToken(null);
          setGithubToken(null);
          sessionStorage.removeItem(GH_TOKEN_KEY);
          setStatus("unauthenticated");
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setAccessToken(null);
    setGithubToken(null);
    sessionStorage.removeItem(GH_TOKEN_KEY);
    setStatus("unauthenticated");
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, accessToken, githubToken, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
