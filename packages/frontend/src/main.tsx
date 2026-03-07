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
    factory().catch((err) => {
      const key = "chunk_reload";
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        window.location.reload();
      }
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
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);
