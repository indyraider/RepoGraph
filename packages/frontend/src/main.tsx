import { lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./AppShell";
import "./index.css";

// Lazy-load views for code splitting
const DashboardView = lazy(() => import("./views/DashboardView"));
const GraphExplorer = lazy(() => import("./GraphExplorer"));
const ActivityLogView = lazy(() => import("./views/ActivityLogView"));
const SettingsView = lazy(() => import("./views/SettingsView"));

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardView />} />
        <Route path="explore" element={<GraphExplorer />} />
        <Route path="activity" element={<ActivityLogView />} />
        <Route path="settings" element={<SettingsView />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  </BrowserRouter>
);
