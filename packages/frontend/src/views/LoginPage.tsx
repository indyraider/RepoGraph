import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Network, Github, AlertTriangle } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../AuthProvider";

export default function LoginPage() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const error = searchParams.get("error");
  const [loading, setLoading] = useState(false);

  // If already authenticated, redirect to dashboard
  useEffect(() => {
    if (status === "authenticated") {
      navigate("/dashboard", { replace: true });
    }
  }, [status, navigate]);

  async function handleSignIn() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        scopes: "read:user repo",
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });
    if (error) {
      console.error("[auth] Sign in error:", error.message);
      setLoading(false);
    }
    // On success, Supabase redirects — no need to handle here
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center justify-center px-4">
      {/* Top accent */}
      <div className="fixed top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent" />

      <div className="max-w-sm w-full text-center">
        {/* Logo */}
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg shadow-violet-500/20 mx-auto mb-6">
          <Network className="w-8 h-8 text-white" />
        </div>

        <h1 className="text-3xl font-bold text-white tracking-tight mb-2">RepoGraph</h1>
        <p className="text-gray-500 text-sm mb-8">
          Repository knowledge graph for Claude Code
        </p>

        {/* Error message */}
        {error && (
          <div className="mb-6 text-sm text-red-400 bg-red-500/10 px-4 py-3 rounded-lg border border-red-500/10 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Authentication failed. Please try again.
          </div>
        )}

        {/* Sign in button */}
        <button
          onClick={handleSignIn}
          disabled={loading}
          className="inline-flex items-center justify-center gap-3 w-full bg-gray-800 hover:bg-gray-700 text-white px-6 py-3 rounded-lg font-medium transition-all duration-200 text-sm border border-white/10 hover:border-white/20 shadow-lg disabled:opacity-50"
        >
          <Github className="w-5 h-5" />
          {loading ? "Redirecting..." : "Sign in with GitHub"}
        </button>

        <p className="text-gray-600 text-xs mt-6">
          Sign in to access your repository graphs
        </p>
      </div>
    </div>
  );
}
