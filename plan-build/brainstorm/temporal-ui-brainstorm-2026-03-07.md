# Brainstorm: Temporal Graph Frontend UI

**Created:** 2026-03-07
**Status:** Draft

## Vision

Add a frontend view to the RepoGraph dashboard that visualizes temporal code evolution data. Users should be able to see how their codebase has changed over time: which symbols were introduced/removed, how complexity trends, who changed what and when, and what structurally changed between two commits. The temporal backend pipeline is already built (differ.ts, temporal-loader.ts, commit-ingester.ts, complexity.ts, backfill.ts) and 6 MCP tools exist, but there are **no backend API routes** and **no frontend views** exposing this data yet.

## Existing Context

**Via RepoGraph:** The frontend is a React 19 + Tailwind 4 + Vite 7 SPA with:
- Router: `react-router-dom` v7, routes defined in `main.tsx`
- Shell: `AppShell.tsx` (sidebar + `<Outlet />`)
- Sidebar: `Sidebar.tsx` with `NAV_ITEMS` array (Dashboard, Explore Graph, Activity Log, Runtime Logs, Settings)
- API layer: `api.ts` with `authedFetch()` helper using Supabase JWT auth
- Views: DashboardView, GraphExplorer, ActivityLogView, RuntimeLogsView, SettingsView
- Charting: No charting library installed. GraphExplorer uses `force-graph` (d3-based) for node graphs.
- Styling: Tailwind 4, dark theme (gray-950 bg, violet accents), lucide-react icons

**Backend:** Express server at `packages/backend/src/index.ts` with routes in `routes.ts`. Runtime log routes in `runtime/log-routes.ts` and `runtime/routes.ts`. **No temporal API routes exist yet** — the temporal pipeline writes to Neo4j/Supabase but nothing reads it back for the frontend.

**Temporal data sources (Supabase tables, planned/exist):**
- `commits` — sha, author, timestamp, message, parent_shas
- `complexity_metrics` — repo_id, commit_id, file_path, metric_name, metric_value, timestamp
- `temporal_digest_jobs` — mode, commits_processed, commits_total, stats

**Temporal data sources (Neo4j):**
- Nodes with `valid_from`, `valid_to`, `valid_from_ts`, `valid_to_ts`, `change_type`, `changed_by`
- `INTRODUCED_IN` edges linking symbols to Commit nodes
- Commit nodes with `HAS_COMMIT` and `PARENT_OF` edges

## Components Identified

### 1. Backend Temporal API Routes
- **Responsibility**: Expose temporal data from Neo4j/Supabase to the frontend via REST endpoints
- **Upstream (receives from)**: Neo4j (versioned nodes, INTRODUCED_IN edges, Commit nodes), Supabase (complexity_metrics, commits)
- **Downstream (sends to)**: Frontend API layer (api.ts)
- **External dependencies**: Neo4j session (`getSession()`), Supabase client (`getSupabase()`), auth middleware
- **Hands test**: PASS — same pattern as existing routes.ts, same DB access

### 2. Frontend API Functions (api.ts additions)
- **Responsibility**: Type-safe fetch wrappers for temporal endpoints
- **Upstream (receives from)**: Backend temporal routes (JSON responses)
- **Downstream (sends to)**: TemporalView components (React state)
- **External dependencies**: `authedFetch()` (exists), `API_BASE` (exists)
- **Hands test**: PASS — follows exact pattern of existing API functions

### 3. TemporalView (main view component)
- **Responsibility**: Top-level view at `/history` route, repo selector + tab navigation between sub-views
- **Upstream (receives from)**: Router (URL params), API (repo list)
- **Downstream (sends to)**: Sub-components (SymbolTimeline, ComplexityChart, BlameExplorer, DiffExplorer)
- **External dependencies**: None beyond existing router/auth
- **Hands test**: PASS

### 4. SymbolTimeline Component
- **Responsibility**: Show chronological history of a symbol — when introduced, modified, removed, by whom
- **Upstream (receives from)**: API `getSymbolHistory()` — calls backend which queries Neo4j for versioned nodes + INTRODUCED_IN edges
- **Downstream (sends to)**: Display only (timeline visualization)
- **External dependencies**: Needs a symbol search/picker to select which symbol to view
- **Hands test**: PASS — pure display component

### 5. ComplexityTrendChart Component
- **Responsibility**: Line/area chart showing complexity metrics over time for a file or repo
- **Upstream (receives from)**: API `getComplexityTrend()` — calls backend which queries Supabase `complexity_metrics`
- **Downstream (sends to)**: Display only (chart)
- **External dependencies**: **Needs a charting library** — no chart lib currently installed
- **Hands test**: FAIL — no charting library in package.json. Need to add recharts, chart.js, or similar.

### 6. StructuralBlamePanel Component
- **Responsibility**: Show who introduced/last modified a symbol and in what commit
- **Upstream (receives from)**: API `getStructuralBlame()` — queries Neo4j for earliest INTRODUCED_IN
- **Downstream (sends to)**: Display only (attribution card)
- **External dependencies**: None
- **Hands test**: PASS

### 7. DiffExplorer Component
- **Responsibility**: Show structural changes between two commits — what was added/modified/removed
- **Upstream (receives from)**: API `getDiffGraph()` — queries Neo4j for nodes with INTRODUCED_IN in commit range
- **Downstream (sends to)**: Display only (diff list with created/modified/deleted sections)
- **External dependencies**: Needs commit picker (two dropdowns/inputs for from_ref and to_ref)
- **Hands test**: PASS

### 8. Sidebar + Router Wiring
- **Responsibility**: Add `/history` route to main.tsx and nav item to Sidebar.tsx
- **Upstream (receives from)**: User clicks nav
- **Downstream (sends to)**: TemporalView renders
- **External dependencies**: None
- **Hands test**: PASS — trivial wiring

## Rough Dependency Map

```
[Sidebar nav] → [Router /history] → [TemporalView]
                                          │
                   ┌──────────┬───────────┼───────────┐
                   ▼          ▼           ▼           ▼
            SymbolTimeline  Complexity  Blame      DiffExplorer
                   │        TrendChart  Panel         │
                   ▼          ▼           ▼           ▼
            api.ts:          api.ts:     api.ts:     api.ts:
            getSymbolHistory getComplexity getBlame  getDiffGraph
                   │          │           │           │
                   ▼          ▼           ▼           ▼
            Backend Temporal API Routes (/api/temporal/*)
                   │                      │
                   ▼                      ▼
                 Neo4j                 Supabase
           (versioned nodes)     (complexity_metrics)
```

## Open Questions

1. **Charting library** — recharts (lightweight, React-native) vs chart.js (heavier but more options)? Recharts fits the existing React-only stack better.
2. **Route path** — `/history` or `/temporal` or `/evolution`? Suggest `/history` as most user-intuitive.
3. **Scope of first version** — all 4 sub-views at once, or start with 1-2? Complexity chart + symbol timeline are highest value.
4. **Backfill trigger UI** — should the temporal view have a "Run Backfill" button, or is that a settings/dashboard concern?
5. **Commit picker UX** — dropdown of known commits, or text input for SHA/ref? Dropdown is better UX but requires loading commit list.

## Risks and Concerns

1. **No backend API routes exist** — the temporal pipeline writes data but nothing reads it for the frontend. This is the biggest gap. Without routes, all frontend components are dead ends.
2. **No charting library** — ComplexityTrendChart needs one. Adding a dependency is straightforward but needs a choice.
3. **Empty state** — repos without temporal digests will have no data. Need graceful empty states that explain "run a temporal digest first" or "enable backfill."
4. **Performance** — symbol history queries could return many versions for hot files. Need pagination or result limits.
5. **Temporal data may not exist yet** — the temporal backend pipeline is built but may not have been run on any repos. The UI needs to handle this gracefully.
