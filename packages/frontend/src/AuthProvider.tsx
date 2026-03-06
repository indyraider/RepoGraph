import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { getMe, logout as apiLogout, type AuthUser } from "./api";

interface AuthState {
  status: "loading" | "authenticated" | "unauthenticated";
  user: AuthUser | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  status: "loading",
  user: null,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    getMe()
      .then((u) => {
        setUser(u);
        setStatus("authenticated");
      })
      .catch(() => {
        setStatus("unauthenticated");
      });
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
