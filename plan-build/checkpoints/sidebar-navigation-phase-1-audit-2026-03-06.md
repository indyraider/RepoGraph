# Phase 1 Dependency Audit
**Phase:** Infrastructure & Shell
**Date:** 2026-03-06
**Status:** ISSUES FOUND

## Verified Connections

### Package Dependency (`package.json`)

- [x] **react-router-dom installed** — `"react-router-dom": "^7.13.1"` at line 18 of `packages/frontend/package.json`. Resolved in root `node_modules/react-router-dom/` (hoisted monorepo install). TypeScript compiles cleanly with `npx tsc --noEmit` (zero errors).

### Route Configuration (`src/main.tsx`)

- [x] **BrowserRouter wraps the app** — trigger: `<BrowserRouter>` at line 14 -> effect: enables client-side routing for entire app. Correctly wraps `<Routes>` which wraps all `<Route>` definitions.
- [x] **AppShell is the layout route** — trigger: `<Route element={<AppShell />}>` at line 16 (no `path` prop) -> effect: AppShell renders for all child routes as a layout wrapper. AppShell is imported from `./AppShell` (line 4), file exists at `src/AppShell.tsx`, exports `default function AppShell()`.
- [x] **Index route redirects to /dashboard** — trigger: `<Route index element={<Navigate to="/dashboard" replace />} />` at line 17 -> effect: visiting `/` immediately redirects to `/dashboard`. Uses `replace` to avoid polluting browser history.
- [x] **Dashboard route points to real component** — trigger: `<Route path="dashboard" element={<DashboardView />} />` at line 18. `DashboardView` is lazy-loaded at line 8: `lazy(() => import("./views/DashboardView"))`. File exists at `src/views/DashboardView.tsx`, exports `default function DashboardView()`. Match confirmed.
- [x] **Explore route points to real component** — trigger: `<Route path="explore" element={<GraphExplorer />} />` at line 19. `GraphExplorer` is lazy-loaded at line 9: `lazy(() => import("./GraphExplorer"))`. File exists at `src/GraphExplorer.tsx`, exports `default function GraphExplorer()`. Match confirmed.
- [x] **Activity route points to real component** — trigger: `<Route path="activity" element={<ActivityLogView />} />` at line 20. Lazy-loaded at line 10. File exists at `src/views/ActivityLogView.tsx`, exports `default function ActivityLogView()`. Match confirmed.
- [x] **Settings route points to real component** — trigger: `<Route path="settings" element={<SettingsView />} />` at line 21. Lazy-loaded at line 11. File exists at `src/views/SettingsView.tsx`, exports `default function SettingsView()`. Match confirmed.
- [x] **Catch-all route redirects to /dashboard** — trigger: `<Route path="*" element={<Navigate to="/dashboard" replace />} />` at line 22 -> effect: unknown URLs redirect to dashboard. Matches plan requirement for unknown route handling.
- [x] **All four views are lazy-loaded** — `lazy(() => import(...))` at lines 8-11. AppShell provides `<Suspense>` wrapper with loading fallback (verified in AppShell.tsx). Code splitting will produce separate chunks for each view.

### AppShell Layout (`src/AppShell.tsx`)

- [x] **Renders Sidebar and Outlet correctly** — trigger: component mount -> effect: flex layout with `<Sidebar />` (line 13) as sibling to `<main>` containing `<Outlet />` (line 25). Sidebar is imported from `./Sidebar` (line 4), file exists at `src/Sidebar.tsx`, exports `default function Sidebar()`.
- [x] **ErrorBoundary wraps Outlet** — trigger: `<ErrorBoundary>` at line 16 wraps `<Suspense>` at line 17 wraps `<Outlet />` at line 25 -> effect: errors in any routed view are caught and render fallback UI. ErrorBoundary imported from `./components/ErrorBoundary` (line 5), file exists, exports named `class ErrorBoundary`. Import uses `{ ErrorBoundary }` (named import) matching the named export.
- [x] **Suspense fallback renders loading state** — trigger: lazy-loaded component not yet ready -> effect: centered spinner with "Loading..." text (lines 19-22). Uses `Loader2` from lucide-react (verified icon exists in installed version).
- [x] **Content area fills remaining space** — `<main className="flex-1 overflow-hidden">` at line 15. Parent div is `flex` (line 9). Sidebar has `flex-shrink-0` (line 40 of Sidebar.tsx). Correct flexbox layout.

### ErrorBoundary (`src/components/ErrorBoundary.tsx`)

- [x] **Properly catches errors** — `static getDerivedStateFromError(error: Error)` at line 9 sets `{ error }` state -> `componentDidCatch` at line 12 logs to console -> `render()` at line 15 checks `this.state.error` and renders fallback.
- [x] **Default fallback renders error UI** — trigger: `this.state.error` is truthy -> effect: full-page red error display with `XCircle` icon, "Something went wrong" heading, error message, and stack trace (lines 18-26). Uses `this.props.fallback?.(this.state.error) ?? (default UI)` pattern, allowing custom fallback override.
- [x] **Accepts optional custom fallback prop** — typed as `fallback?: (error: Error) => ReactNode` in the generic parameter (line 5). When provided, custom fallback is called with the error object.
- [x] **Children pass through when no error** — `return this.props.children` at line 28. Correct.

### Sidebar Navigation (`src/Sidebar.tsx`)

- [x] **Four NavLink items match defined routes** — `NAV_ITEMS` array at lines 12-17 defines: `to="/dashboard"`, `to="/explore"`, `to="/activity"`, `to="/settings"`. All four match the route `path` values in `main.tsx` (lines 18-21: `dashboard`, `explore`, `activity`, `settings`). Exact match confirmed.
- [x] **NavLink isActive highlights current route** — trigger: `className` callback at line 64 receives `{ isActive }` -> effect: active state applies `bg-violet-500/10 text-violet-400 border border-violet-500/20` (line 67), inactive state applies `text-gray-400 hover:text-gray-200` (line 68). react-router-dom's NavLink automatically sets `isActive` based on the current URL matching the `to` prop. No manual `useLocation()` needed.
- [x] **Collapse toggle has real handler** — trigger: `onClick={() => setCollapsed((c) => !c)}` at line 87 -> effect: toggles `collapsed` state. Button renders `PanelLeftOpen` when collapsed, `PanelLeftClose` when expanded (lines 90-93). Both icons verified to exist in lucide-react v0.577.0.
- [x] **Collapse state persists to localStorage** — trigger: `collapsed` state changes -> effect: `useEffect` at lines 30-36 calls `localStorage.setItem(STORAGE_KEY, String(collapsed))`. Key is `"repograph-sidebar-collapsed"` (line 19). Initial state reads from localStorage at lines 22-28: `localStorage.getItem(STORAGE_KEY) !== "false"`. Try/catch guards both read and write against localStorage unavailability.
- [x] **Sidebar width transitions correctly** — `transition-[width] duration-200 ease-in-out` on the `<aside>` element (line 40). Collapsed: `w-[60px]`, expanded: `w-[220px]` (lines 41-42). Matches plan spec of 60px icon rail and 220px expanded width.
- [x] **Labels hide when collapsed** — trigger: `collapsed` is true -> effect: label spans get `opacity-0 w-0 overflow-hidden` classes (lines 74-76, 96-98, 50-52). Smooth opacity transition via `transition-opacity duration-200`. Logo text "RepoGraph" also hides (lines 50-52).

### GraphExplorer Prop Change (`src/GraphExplorer.tsx`)

- [x] **onBack prop is optional** — `onBack?: () => void` at line 112 (note the `?`). Component can be rendered without the prop, as done in `main.tsx` line 19: `<GraphExplorer />` (no props passed). TypeScript compiles cleanly confirming type compatibility.

## Stubs & Placeholders Found

### Expected Placeholders (per plan)

- **DashboardView** (`src/views/DashboardView.tsx`) — renders centered placeholder text: "Dashboard -- will be wired in Phase 2". Expected stub, will be replaced in Phase 2.
- **ActivityLogView** (`src/views/ActivityLogView.tsx`) — renders centered placeholder text: "Activity Log -- will be built in Phase 3". Expected stub, will be replaced in Phase 3.
- **SettingsView** (`src/views/SettingsView.tsx`) — renders centered placeholder text: "Settings -- will be built in Phase 3". Expected stub, will be replaced in Phase 3.

### Other Notes

- No TODO, FIXME, HACK, STUB, or XXX markers found in any Phase 1 file.
- `src/App.tsx` still contains the old view-toggle architecture (line 413: `useState<"digest" | "explore">`), the embedded `ErrorBoundary` class (lines 47-73), `McpPanel` (lines 343-410), and `SyncPanel` (lines 108-341). This is expected -- App.tsx will be gutted in Phase 2 when DashboardView extracts its content.

## Broken Chains

### 1. GraphExplorer Back button still renders when onBack is undefined

- **The chain:** User navigates to `/explore` via sidebar -> main.tsx renders `<GraphExplorer />` with no props -> GraphExplorer renders Back button (lines 482-488) with `onClick={onBack}` where `onBack` is `undefined`
- **Breaks at:** GraphExplorer.tsx lines 482-488. The Back button is always rendered regardless of whether `onBack` is provided. When `onBack` is `undefined`, `onClick={undefined}` is harmless (React ignores it), so clicking the button does nothing.
- **Impact:** LOW. The button is visually present but non-functional. No crash, no error. It is dead UI.
- **Fix:** The plan explicitly schedules "Remove Back button from GraphExplorer top bar" for Phase 2. No action needed now, but Phase 2 audit must verify this is done. Optionally, guard the button render with `{onBack && (<button ...>)}` now to avoid confusing users during development.

### 2. Duplicate top accent line when GraphExplorer renders inside AppShell

- **The chain:** AppShell renders a gradient accent line at line 11: `<div className="absolute top-0 ... h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent z-50" />`. GraphExplorer also renders its own accent line at line 477: `<div className="h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent" />`.
- **Breaks at:** Visual duplication. GraphExplorer was designed as a full-page component (note `h-screen` at line 475) before the AppShell existed. Now rendered inside AppShell's `<main>`, both accent lines are visible.
- **Impact:** LOW. Cosmetic only. The AppShell accent is `absolute top-0 z-50` spanning the full width. The GraphExplorer accent is relative, positioned at the top of its content area. Users see two subtle gradient lines.
- **Fix:** Phase 2 should remove GraphExplorer's own accent line (line 477) and change `h-screen` (line 475) to `h-full` since it is no longer the root element.

### 3. GraphExplorer uses `h-screen` instead of `h-full`

- **The chain:** GraphExplorer's root div uses `h-screen` (line 475) -> rendered inside AppShell's `<main className="flex-1 overflow-hidden">` -> GraphExplorer tries to be viewport-height but is constrained by the flex container.
- **Breaks at:** `h-screen` sets `height: 100vh` which equals the full viewport. Inside the AppShell flex layout, the main area is already `flex-1 overflow-hidden`. Since the main area is the full viewport minus zero (sidebar is beside it, not above), `h-screen` happens to work by coincidence -- but it is semantically wrong. If any top bar or bottom bar were added to AppShell in the future, GraphExplorer would overflow.
- **Impact:** LOW. Currently works because AppShell has no vertical chrome consuming height. The `overflow-hidden` on `<main>` clips any overflow.
- **Fix:** Phase 2 should change `h-screen` to `h-full` on GraphExplorer's root div.

## Missing Configuration

None. All dependencies are installed and resolvable. TypeScript compiles with zero errors. All imports resolve to existing modules.

## Summary

Phase 1 is clean and correctly wired. All seven checklist items are implemented: react-router-dom is installed (v7.13.1), ErrorBoundary is extracted to a shared component, AppShell renders Sidebar + Outlet in a proper flex layout, Sidebar provides four NavLink items that exactly match the four defined routes, main.tsx wraps the app in BrowserRouter with correct route configuration including index redirect and catch-all, three placeholder views exist with default exports, and GraphExplorer's onBack prop is optional. The ErrorBoundary correctly catches errors via getDerivedStateFromError and renders a sensible fallback. The Sidebar's collapse state persists to localStorage with proper try/catch guards. NavLink's built-in isActive mechanism handles route highlighting without manual useLocation calls. All lazy imports point to real files with default exports.

The three issues found are all LOW severity and cosmetic/structural: (1) GraphExplorer's Back button renders but does nothing when onBack is undefined -- explicitly scheduled for Phase 2 removal; (2) duplicate accent gradient lines from both AppShell and GraphExplorer; (3) GraphExplorer uses h-screen instead of h-full. None block Phase 2. The old App.tsx is untouched and still functional as the source for Phase 2's DashboardView extraction.
