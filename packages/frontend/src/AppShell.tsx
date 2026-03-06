import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Loader2 } from "lucide-react";
import Sidebar from "./Sidebar";
import { ErrorBoundary } from "./components/ErrorBoundary";

export default function AppShell() {
  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex overflow-hidden">
      {/* Subtle top accent line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent z-50" />

      <Sidebar />

      <main className="flex-1 overflow-hidden">
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
                <span className="text-sm">Loading...</span>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
