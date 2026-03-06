# Brainstorm: Collapsible Sidebar Navigation

**Created:** 2026-03-06
**Status:** Draft

## Vision

Replace the current two-state view toggle (digest ↔ explore) with a persistent
collapsible sidebar that serves as the primary navigation for RepoGraph. The
sidebar starts as a narrow icon rail (~60px) and expands to show labels (~220px)
on hover or toggle. This accommodates the four initial views — Dashboard, Explore
Graph, Activity Log, and Settings — and makes it trivial to add more in the future.

## Existing Context

**Current architecture:**
- Single `App.tsx` component manages a `view` state (`"digest"` | `"explore"`)
- No router — views are swapped via conditional rendering
- `GraphExplorer.tsx` is lazy-loaded, receives `onBack` callback
- Layout: centered `max-w-4xl` for dashboard, full-screen for graph explorer
- Styling: Tailwind 4, `index.css` for custom utilities, lucide-react icons
- No component directory — everything lives flat in `src/`

**Current navigation flow:**
- "Explore Graph" button in header → sets `view = "explore"`
- "Back" button in GraphExplorer top bar → calls `onBack()` → sets `view = "digest"`
- No URL-based routing, no browser history integration

## Components Identified

### 1. AppShell (new)
- **Responsibility**: Top-level layout wrapper — renders sidebar + content area
- **Upstream (receives from)**: `main.tsx` renders it as root component
- **Downstream (sends to)**: Renders `Sidebar` and the active view component
- **External dependencies**: None
- **Hands test**: PASS — pure layout component

### 2. Sidebar (new)
- **Responsibility**: Collapsible navigation rail with icon+label menu items
- **Upstream (receives from)**: AppShell renders it; needs current active view
  and a setter/callback to change views
- **Downstream (sends to)**: Triggers view changes in AppShell
- **External dependencies**: lucide-react icons
- **Hands test**: PASS — click handlers update parent state

### 3. DashboardView (refactored from App digest view)
- **Responsibility**: Repo digest input, repo list, sync panels, MCP panel —
  everything currently in the `view === "digest"` branch of App.tsx
- **Upstream (receives from)**: AppShell renders it when "dashboard" is active
- **Downstream (sends to)**: API calls (digest, delete, refresh repos)
- **External dependencies**: api.ts functions
- **Hands test**: PASS — already works, just needs extraction

### 4. GraphExplorer (existing, minor refactor)
- **Responsibility**: Force-graph visualization of repo knowledge graph
- **Upstream (receives from)**: AppShell renders it when "explore" is active
- **Downstream (sends to)**: API calls (graph data, file content)
- **External dependencies**: force-graph library, api.ts
- **Hands test**: PASS — currently receives `onBack` prop which will be removed
  since sidebar handles navigation now

### 5. ActivityLogView (new)
- **Responsibility**: Dedicated view showing sync events, digest history, and
  system activity across all repositories
- **Upstream (receives from)**: AppShell renders it when "activity" is active
- **Downstream (sends to)**: API calls for sync events + digest job history
- **External dependencies**: api.ts — `getSyncEvents()` exists per-repo, may
  need a global activity endpoint or client-side aggregation across repos
- **Hands test**: PARTIAL — `getSyncEvents(repoId)` exists but is per-repo.
  For a global activity view, we either need a new API endpoint or we fetch
  events for all repos and merge client-side.

### 6. SettingsView (new)
- **Responsibility**: Centralized settings page for API connection config, MCP
  setup, and potentially API key management
- **Upstream (receives from)**: AppShell renders it when "settings" is active
- **Downstream (sends to)**: Reads/writes env config, displays MCP panel
- **External dependencies**: api.ts health check; McpPanel already exists in
  App.tsx and can be extracted
- **Hands test**: PARTIAL — McpPanel exists but is currently hardcoded per-repo.
  Settings view would show global config. Actual env var management (VITE_API_URL,
  VITE_API_KEY) is build-time, not runtime-configurable — settings view can
  display current values and connection status but can't change them in-app.

## Rough Dependency Map

```
main.tsx
  └─ AppShell
       ├─ Sidebar ← (activeView, onNavigate)
       └─ Content area (conditional on activeView)
            ├─ DashboardView   (activeView === "dashboard")
            ├─ GraphExplorer    (activeView === "explore")
            ├─ ActivityLogView  (activeView === "activity")
            └─ SettingsView     (activeView === "settings")
```

State flow: `activeView` lives in AppShell, Sidebar calls `onNavigate(view)`
to change it. Each view is self-contained with its own API calls and state.

## Open Questions

1. **Routing**: Should we add react-router for URL-based navigation (e.g.,
   `/explore`, `/activity`) or keep it state-based? URL routing gives
   bookmarkable views and browser back/forward support but adds a dependency.

2. **Activity Log data source**: The current API has `getSyncEvents(repoId)` —
   per-repo only. For a cross-repo activity log, do we:
   - (a) Add a backend endpoint for global activity
   - (b) Fetch events for all repos client-side and merge
   - (c) Start with per-repo activity (repo selector dropdown) and add global later

3. **Settings scope**: What's actually configurable at runtime vs build-time?
   Current env vars (VITE_API_URL, VITE_API_KEY) are baked in at build time.
   Settings view may be more of a "status + copy config" view than a "change
   settings" view — unless we add localStorage-based overrides.

4. **GraphExplorer sidebar conflict**: GraphExplorer already has its own
   left sidebar (node type filter, 208px). With the app-level sidebar added,
   the graph view will have two sidebars. Need to decide: does the app sidebar
   collapse/hide when in graph view, or do they coexist?

## Risks and Concerns

- **GraphExplorer double-sidebar UX**: The graph view's type-filter sidebar
  + the new nav sidebar could feel cramped, especially on smaller screens.
  The collapsible design helps (icon rail is only ~60px) but still worth
  testing.

- **Activity Log is a new feature, not just a layout change**: It needs real
  data. If the backend doesn't have a global activity endpoint, the initial
  version will need scoped expectations.

- **Settings view utility**: Without runtime config, it's mostly a read-only
  status page. Need to make sure it still feels useful (connection status,
  MCP config copy, health checks).

- **Extraction complexity**: The digest view in App.tsx is ~300 lines with
  multiple local state variables and handler functions. Extracting it cleanly
  into DashboardView requires moving all that state — doable but needs care.
