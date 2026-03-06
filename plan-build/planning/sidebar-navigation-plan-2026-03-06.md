# Build Plan: Collapsible Sidebar Navigation

**Created:** 2026-03-06
**Brainstorm:** ../brainstorm/sidebar-navigation-brainstorm-2026-03-06.md
**Status:** Draft

## Overview

Restructure the RepoGraph frontend from a two-state view toggle into a proper
app shell with collapsible sidebar navigation and react-router. The sidebar
starts as a ~60px icon rail and expands to ~220px on hover/toggle. Four views:
Dashboard (existing digest view), Explore Graph (existing), Activity Log (new,
per-repo with selector), and Settings (new, connection status + MCP config).
The sidebar always shows as the icon rail, even in GraphExplorer (which keeps
its own type-filter sidebar).

## Component Inventory

| Component | Type | Inputs | Outputs | Dependencies |
|-----------|------|--------|---------|-------------|
| AppShell | New | react-router outlet | Renders Sidebar + routed content | react-router-dom |
| Sidebar | New | current route, collapsed state | Route navigation via react-router | lucide-react, react-router-dom |
| DashboardView | Extracted from App.tsx | None (self-contained) | API calls: digest, delete, refresh | api.ts |
| GraphExplorer | Refactored | None (remove onBack prop) | API calls: graph data, file content | api.ts, force-graph |
| ActivityLogView | New | None | API calls: getSyncEvents per repo, getRepositories | api.ts |
| SettingsView | New | None | API calls: checkHealth | api.ts (McpPanel extracted) |
| McpPanel | Extracted from App.tsx | None | Clipboard copy | None |
| ErrorBoundary | Existing (move to shared) | children | Error UI | None |

## Integration Contracts

### main.tsx → BrowserRouter → AppShell
- **What flows**: React Router wraps the app, AppShell is the root layout route
- **How**: `<BrowserRouter><Routes><Route element={<AppShell />}>...</Route></Routes></BrowserRouter>`
- **Auth/Config**: None
- **Error path**: N/A (pure layout)

### AppShell → Sidebar
- **What flows**: Sidebar rendered as sibling to `<Outlet />` in a flex layout
- **How**: Sidebar reads current route via `useLocation()` to highlight active item
- **Auth/Config**: None
- **Error path**: N/A

### Sidebar → Views (via react-router)
- **What flows**: Navigation events via `<Link>` or `useNavigate()`
- **How**: Sidebar items are `<NavLink to="/explore">` etc.
- **Routes**:
  - `/` or `/dashboard` → DashboardView
  - `/explore` → GraphExplorer (lazy-loaded)
  - `/activity` → ActivityLogView
  - `/settings` → SettingsView
- **Error path**: Unknown routes → redirect to `/`

### ActivityLogView → api.ts
- **What flows**: Fetches repos list, then sync events for selected repo
- **How**: `getRepositories()` → repo selector → `getSyncEvents(selectedRepoId)`
- **Auth/Config**: Uses existing `authHeaders()` from api.ts
- **Error path**: Show error state in view if fetch fails

### SettingsView → api.ts
- **What flows**: Health check status, displays current config
- **How**: `checkHealth()` on mount
- **Auth/Config**: Reads from existing env vars (display only)
- **Error path**: Shows "unreachable" status if health check fails

### DashboardView (self-contained)
- **What flows**: All existing digest/repo logic moves from App.tsx
- **How**: Direct extraction — state, handlers, and JSX all move together
- **Auth/Config**: Same api.ts calls
- **Error path**: Same error handling as current App.tsx

### GraphExplorer (minor change)
- **What flows**: Remove `onBack` prop, remove Back button from top bar
- **How**: Navigation handled by sidebar; GraphExplorer no longer needs escape hatch
- **Auth/Config**: No change
- **Error path**: No change

## End-to-End Flows

### Flow 1: User navigates between views
```
1. User clicks icon in collapsed sidebar (e.g., Activity icon)
2. Sidebar <NavLink to="/activity"> triggers react-router navigation
3. React Router matches "/activity" route → renders ActivityLogView
4. Sidebar highlights active item based on useLocation().pathname
5. Content area updates, sidebar stays in place
```

### Flow 2: User expands/collapses sidebar
```
1. User clicks toggle button at bottom of sidebar (or hovers, depending on mode)
2. Sidebar state toggles: collapsed (60px) ↔ expanded (220px)
3. CSS transition animates width change
4. Content area flexes to fill remaining space
5. Preference persisted to localStorage
```

### Flow 3: User views Activity Log
```
1. ActivityLogView mounts → calls getRepositories()
2. Repos populate dropdown selector, first repo auto-selected
3. getSyncEvents(selectedRepoId) fetches events for that repo
4. Events rendered in chronological table/list
5. User changes repo in dropdown → new getSyncEvents() call
```

### Flow 4: GraphExplorer with sidebar
```
1. User clicks Explore icon in sidebar
2. React Router renders GraphExplorer
3. App sidebar stays as collapsed icon rail (60px)
4. GraphExplorer renders its own type-filter sidebar (208px) next to the graph
5. Layout: [60px app rail] [208px type filters] [rest: graph canvas] [detail panel if open]
```

### Error Flow: Unknown URL
```
1. User navigates to /unknown
2. React Router catch-all route redirects to /
3. DashboardView renders
```

## Issues Found

### 1. No react-router dependency
- **Status**: react-router-dom is not installed
- **Fix**: `npm install react-router-dom` in packages/frontend

### 2. GraphExplorer `onBack` prop becomes dead code
- **Status**: GraphExplorer accepts `onBack` prop, used only for the Back button
- **Fix**: Remove `onBack` prop and the Back button. Navigation now via sidebar.

### 3. McpPanel is embedded in App.tsx per-repo
- **Status**: McpPanel renders inside each expanded repo card. For Settings,
  we want a standalone version.
- **Fix**: Extract McpPanel to its own file. Use it in both DashboardView
  (per-repo context) and SettingsView (global context).

### 4. ErrorBoundary is defined inside App.tsx
- **Status**: Currently only wraps GraphExplorer
- **Fix**: Extract to shared component. Wrap each view route in AppShell.

### 5. Sidebar collapse state persistence
- **Status**: No localStorage usage currently
- **Fix**: Store sidebar collapsed/expanded preference in localStorage

### 6. CopyButton and StatusBadge are in App.tsx
- **Status**: Utility components embedded in main file
- **Fix**: Extract to a shared components file or keep in DashboardView
  (they're small — extract only if needed by multiple views)

## Wiring Checklist

### Package Dependencies
- [ ] Install react-router-dom in packages/frontend

### New Files to Create
- [ ] `src/AppShell.tsx` — layout wrapper with sidebar + Outlet
- [ ] `src/Sidebar.tsx` — collapsible nav component
- [ ] `src/views/DashboardView.tsx` — extracted from App.tsx digest view
- [ ] `src/views/ActivityLogView.tsx` — new activity log view
- [ ] `src/views/SettingsView.tsx` — new settings/status view
- [ ] `src/components/McpPanel.tsx` — extracted from App.tsx
- [ ] `src/components/ErrorBoundary.tsx` — extracted from App.tsx

### Files to Modify
- [ ] `src/main.tsx` — wrap App in BrowserRouter, set up routes
- [ ] `src/App.tsx` — replace with AppShell + route config (or remove entirely)
- [ ] `src/GraphExplorer.tsx` — remove `onBack` prop and Back button
- [ ] `src/index.css` — add sidebar transition styles if needed

### Route Wiring
- [ ] `/` → redirect to `/dashboard`
- [ ] `/dashboard` → DashboardView
- [ ] `/explore` → GraphExplorer (lazy)
- [ ] `/activity` → ActivityLogView
- [ ] `/settings` → SettingsView
- [ ] `*` → redirect to `/dashboard`

### Sidebar ↔ Content Wiring
- [ ] Sidebar reads `useLocation()` to highlight active nav item
- [ ] Sidebar items use `<NavLink>` for navigation
- [ ] Sidebar collapse/expand state in local state + localStorage
- [ ] CSS transition on sidebar width (60px ↔ 220px)
- [ ] Content area uses `flex-1` to fill remaining space

### Data Wiring (ActivityLogView)
- [ ] Fetch repos on mount via `getRepositories()`
- [ ] Repo selector dropdown controls which repo's events are shown
- [ ] Fetch events via `getSyncEvents(selectedRepoId)` on repo change
- [ ] Loading/empty/error states for events list

### Data Wiring (SettingsView)
- [ ] Fetch health status via `checkHealth()` on mount
- [ ] Display connection status (Neo4j, Supabase)
- [ ] Render McpPanel for MCP config copy
- [ ] Display current API URL and key status (masked)

### Cleanup
- [ ] Remove `view` state and conditional rendering from old App.tsx
- [ ] Remove "Explore Graph" button from dashboard header
- [ ] Remove `onBack` prop from GraphExplorer
- [ ] Remove Back button from GraphExplorer top bar

## Build Order

### Phase 1: Infrastructure & Shell
Install react-router-dom. Create AppShell, Sidebar, and route config.
Extract ErrorBoundary. Wire up main.tsx with BrowserRouter. At this point
the app should render the sidebar and show a placeholder for each route.

**Files**: react-router-dom install, `src/components/ErrorBoundary.tsx`,
`src/AppShell.tsx`, `src/Sidebar.tsx`, `src/main.tsx` (modified)

### Phase 2: Extract & Migrate DashboardView
Move all digest-view code from App.tsx into `src/views/DashboardView.tsx`.
Extract McpPanel to `src/components/McpPanel.tsx`. Extract CopyButton and
StatusBadge if needed by other views. Wire DashboardView to the `/dashboard`
route. Remove old view toggle from App.tsx.

**Files**: `src/views/DashboardView.tsx`, `src/components/McpPanel.tsx`,
`src/App.tsx` (gutted or removed), `src/GraphExplorer.tsx` (remove onBack)

### Phase 3: New Views — Activity Log & Settings
Build ActivityLogView with repo selector and events list. Build SettingsView
with health status and MCP config. Wire both to their routes.

**Files**: `src/views/ActivityLogView.tsx`, `src/views/SettingsView.tsx`

### Phase 4: Polish & Cleanup
CSS transitions for sidebar. localStorage persistence. Final styling pass.
Remove any dead code. Test all routes and navigation flows.

**Files**: `src/index.css`, various touch-ups
