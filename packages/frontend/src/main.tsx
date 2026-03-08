import { lazy, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./AuthProvider";
import AppShell from "./AppShell";
import "./index.css";

// Retry dynamic imports once with a full page reload on chunk load failure
// (handles stale HTML referencing old chunk hashes after redeployment)
function lazyWithRetry(factory: () => Promise<{ default: ComponentType<unknown> }>) {
  return lazy(() =>
    factory()
      .then((mod) => {
        // Successful load — clear the reload flag so future deploys can retry
        sessionStorage.removeItem("chunk_reload");
        return mod;
      })
      .catch((err) => {
        const key = "chunk_reload";
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          window.location.reload();
          // Return a never-resolving promise so React doesn't render the error
          // before the browser has a chance to reload
          return new Promise(() => {});
        }
        // Already retried once — surface the error
        sessionStorage.removeItem(key);
        throw err;
      })
  );
}

// Lazy-load views for code splitting
const LoginPage = lazyWithRetry(() => import("./views/LoginPage"));
const DashboardView = lazyWithRetry(() => import("./views/DashboardView"));
const GraphExplorer = lazyWithRetry(() => import("./GraphExplorer"));
const ActivityLogView = lazyWithRetry(() => import("./views/ActivityLogView"));
const RuntimeLogsView = lazyWithRetry(() => import("./views/RuntimeLogsView"));
const SettingsView = lazyWithRetry(() => import("./views/SettingsView"));
const HistoryView = lazyWithRetry(() => import("./views/HistoryView"));

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardView />} />
          <Route path="explore" element={<GraphExplorer />} />
          <Route path="activity" element={<ActivityLogView />} />
          <Route path="logs" element={<RuntimeLogsView />} />
          <Route path="history" element={<HistoryView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);
