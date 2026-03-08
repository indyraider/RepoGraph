# Build Plan: Temporal Graph Frontend UI

**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/temporal-ui-brainstorm-2026-03-07.md
**PRD:** N/A (companion to temporal-graph-plan-2026-03-07.md)
**Status:** Draft

## Overview

Add a `/history` view to the RepoGraph frontend that visualizes temporal code evolution data across four sub-views: Symbol Timeline, Complexity Trends, Structural Blame, and Diff Explorer — plus an inline backfill trigger. This requires new backend API routes (the temporal pipeline writes to Neo4j/Supabase but has zero read routes), new frontend API functions, a new view with four tab-panels, and the addition of `recharts` for charting.

## Component Inventory

| # | Component | New/Modify | Inputs | Outputs | Key Dependencies |
|---|-----------|-----------|--------|---------|-----------------|
| 1 | Backend Temporal Routes | New | Neo4j session, Supabase client, auth middleware | REST JSON responses | Express Router, getSession(), getSupabase() |
| 2 | Frontend API Functions | Modify | Backend JSON responses | Typed data for React components | `api.ts`, `authedFetch()` |
| 3 | HistoryView (main) | New | Router params, repo list API | Renders 4 tab sub-views | react-router-dom, api.ts |
| 4 | SymbolTimeline | New | `getSymbolHistory()` response | Vertical timeline UI | HistoryView (parent) |
| 5 | ComplexityTrendChart | New | `getComplexityTrend()` response | Recharts line/area chart | recharts |
| 6 | StructuralBlamePanel | New | `getStructuralBlame()` response | Attribution card UI | HistoryView (parent) |
| 7 | DiffExplorer | New | `getDiffGraph()` response | Created/modified/deleted sections | HistoryView (parent) |
| 8 | BackfillPanel | New | `triggerBackfill()` + `getBackfillStatus()` | Progress bar + trigger button | HistoryView (parent) |
| 9 | Router + Sidebar Wiring | Modify | N/A | `/history` route + nav item | main.tsx, Sidebar.tsx |
| 10 | recharts dependency | New | N/A | Charting library available | package.json |

## Integration Contracts

### Contract 1: Backend → Neo4j (Symbol History)

```
GET /api/temporal/:repoId/symbol-history?name=X&kind=Y&since=Z&limit=N
  What flows:     Query Neo4j for all versions of a symbol ordered by valid_from_ts DESC
  Cypher:         MATCH (sym {name: $name, repo_url: $repoUrl})
                  WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
                  OPTIONAL MATCH (sym)-[r:INTRODUCED_IN]->(c:Commit)
                  RETURN sym.name, sym.signature, sym.file_path, sym.valid_from,
                         sym.valid_from_ts, sym.valid_to, sym.valid_to_ts,
                         sym.change_type, sym.changed_by, c.message, c.sha
                  ORDER BY sym.valid_from_ts DESC
                  LIMIT $limit
  Auth:           Supabase JWT (same as existing routes, user must own repo)
  Error path:     Empty array if no temporal data exists (repo never temporal-digested)
  Response:       { versions: SymbolVersion[] }
```

### Contract 2: Backend → Supabase (Complexity Trend)

```
GET /api/temporal/:repoId/complexity-trend?file_path=X&metric=Y&since=Z
  What flows:     Query Supabase complexity_metrics for time-series data
  SQL:            SELECT commit_sha, file_path, metric_name, metric_value, timestamp
                  FROM complexity_metrics
                  WHERE repo_id = $repoId AND file_path = $filePath
                    AND metric_name = $metric AND timestamp >= $since
                  ORDER BY timestamp ASC
  Auth:           Supabase JWT via RLS (or service key + manual repo ownership check)
  Error path:     Empty array if no metrics exist
  Response:       { data: ComplexityDataPoint[] }
```

### Contract 3: Backend → Neo4j (Structural Blame)

```
GET /api/temporal/:repoId/structural-blame?name=X&kind=Y
  What flows:     Query for earliest INTRODUCED_IN edge for a symbol
  Cypher:         MATCH (sym {name: $name, repo_url: $repoUrl})-[:INTRODUCED_IN]->(c:Commit)
                  WHERE sym.change_type = "created"
                  RETURN sym.name, sym.file_path, c.sha, c.author, c.author_email,
                         c.message, c.timestamp
                  ORDER BY c.timestamp ASC
                  LIMIT 1
  Auth:           Same repo ownership check
  Error path:     404 if symbol not found, empty if no temporal data
  Response:       { blame: BlameResult | null }
```

### Contract 4: Backend → Neo4j (Diff Graph)

```
GET /api/temporal/:repoId/diff?from_ref=X&to_ref=Y&scope=Z
  What flows:     Query for nodes with INTRODUCED_IN in commit range [from..to]
  Cypher:         MATCH (sym)-[r:INTRODUCED_IN]->(c:Commit {repo_url: $repoUrl})
                  WHERE c.timestamp >= $fromTs AND c.timestamp <= $toTs
                  RETURN sym.name, sym.kind, sym.file_path, r.change_type,
                         c.sha, c.author, c.message, c.timestamp
                  ORDER BY c.timestamp ASC
  Auth:           Same repo ownership check
  Error path:     Empty arrays if no changes in range
  Response:       { created: DiffEntry[], modified: DiffEntry[], deleted: DiffEntry[] }
```

### Contract 5: Backend → Supabase (Commits List)

```
GET /api/temporal/:repoId/commits?limit=N
  What flows:     Query Supabase commits table for repo's commit list
  SQL:            SELECT sha, author, message, timestamp
                  FROM commits WHERE repo_id = $repoId
                  ORDER BY timestamp DESC LIMIT $limit
  Auth:           RLS or manual ownership check
  Error path:     Empty array if no commits ingested
  Response:       { commits: CommitSummary[] }
```

### Contract 6: Backend → Backfill Trigger

```
POST /api/temporal/:repoId/backfill
  Body:           { maxCommits?: number }
  What flows:     Calls runHistoricalBackfill() (exists at backfill.ts:42)
  Auth:           Supabase JWT, user must own repo
  Error path:     409 if backfill already running, 404 if repo not found
  Response:       { jobId: string, status: "started" }
```

### Contract 7: Backend → Backfill Status

```
GET /api/temporal/:repoId/backfill/status
  What flows:     Query temporal_digest_jobs for latest job for this repo
  SQL:            SELECT * FROM temporal_digest_jobs
                  WHERE repo_id = $repoId ORDER BY started_at DESC LIMIT 1
  Response:       { job: TemporalDigestJob | null }
```

### Contract 8: Frontend API → Backend Routes

```
api.ts functions → authedFetch() → /api/temporal/* endpoints
  What flows:     Typed request/response wrappers
  How it flows:   Same pattern as getRepositories(), getRuntimeLogs(), etc.
  Auth:           authedFetch() handles JWT automatically
  Error path:     Throw on non-ok responses with error message from body
```

### Contract 9: HistoryView → Router + Sidebar

```
main.tsx: <Route path="history" element={<HistoryView />} />
Sidebar.tsx: NAV_ITEMS += { to: "/history", icon: GitCommitHorizontal, label: "History" }
  What flows:     URL navigation → view rendering
  How it flows:   react-router-dom <Outlet />, NavLink
  Error path:     N/A (framework-level routing)
```

## End-to-End Flows

### Flow 1: User Views Symbol History

```
1.  User navigates to /history
2.  HistoryView loads, fetches repo list via getRepositories() (existing API)
3.  User selects a repo from dropdown
4.  HistoryView fetches commits list: GET /api/temporal/:repoId/commits
5.  If no commits returned → show BackfillPanel empty state
6.  User clicks "Symbol Timeline" tab
7.  SymbolTimeline shows a search input for symbol name
8.  User types "processPayment" → debounced search
9.  Frontend calls getSymbolHistory(repoId, "processPayment")
10. Backend queries Neo4j for all versions with INTRODUCED_IN edges
11. Returns SymbolVersion[] with signature, change_type, changed_by, commit message
12. SymbolTimeline renders vertical timeline with version cards
```

### Flow 2: User Views Complexity Trends

```
1.  User clicks "Complexity" tab in HistoryView
2.  ComplexityTrendChart shows file picker (populated from repo file list)
3.  User selects a file → fetches getComplexityTrend(repoId, filePath, "coupling_score")
4.  Backend queries Supabase complexity_metrics
5.  Returns time-series data: [{ commit_sha, metric_value, timestamp }]
6.  Recharts renders line chart with time on X axis, metric value on Y
7.  User can toggle metric type: coupling_score, import_count, symbol_count
```

### Flow 3: User Explores Diff Between Commits

```
1.  User clicks "Diff Explorer" tab
2.  Two commit pickers (from/to) populated from commits list
3.  User selects from_ref and to_ref
4.  Frontend calls getDiffGraph(repoId, fromRef, toRef)
5.  Backend queries Neo4j for nodes with INTRODUCED_IN in range
6.  Returns { created: [], modified: [], deleted: [] }
7.  DiffExplorer renders three collapsible sections with symbol cards
```

### Flow 4: User Triggers Backfill

```
1.  User is on /history for a repo with no temporal data
2.  Empty state shows "No history data yet" + BackfillPanel
3.  User sets maxCommits (slider or input, default 50)
4.  User clicks "Run Backfill"
5.  Frontend calls POST /api/temporal/:repoId/backfill { maxCommits: 50 }
6.  Backend validates repo ownership, checks no active backfill (409 if running)
7.  Backend calls runHistoricalBackfill() (fire-and-forget in background)
8.  Returns { jobId, status: "started" }
9.  BackfillPanel polls GET /api/temporal/:repoId/backfill/status every 5s
10. Shows progress bar: commits_processed / commits_total
11. On completion, reloads commits list and shows temporal tabs
```

### Flow 5: Error Path — Repo Without Temporal Data

```
1.  User selects a repo that has never had a temporal digest
2.  GET /api/temporal/:repoId/commits returns { commits: [] }
3.  HistoryView shows empty state with:
    - "No temporal data for this repository"
    - "Run a backfill to analyze commit history"
    - BackfillPanel with trigger button
4.  All tab sub-views show contextual empty states
5.  Symbol Timeline: "No symbol history available"
6.  Complexity: "No complexity metrics computed"
7.  etc.
```

## Issues Found

### 1. No Backend Temporal API Routes Exist
- **Location:** `packages/backend/src/` — no temporal route file
- **Impact:** All frontend components are dead ends without these routes. This is the #1 blocker.
- **Fix:** Create `packages/backend/src/temporal-routes.ts` with 7 endpoints, mount in `index.ts`

### 2. No Charting Library Installed
- **Location:** `packages/frontend/package.json` — no recharts/chart.js
- **Impact:** ComplexityTrendChart cannot render charts
- **Fix:** `npm install recharts` in frontend package

### 3. Backfill Needs Background Execution
- **Location:** `backfill.ts:42` — `runHistoricalBackfill()` is async but blocking
- **Impact:** POST /api/temporal/:repoId/backfill can't block the request for the full duration (could be minutes). Must fire-and-forget.
- **Fix:** Call `runHistoricalBackfill()` without await, return job ID immediately. The function already updates `temporal_digest_jobs` table with progress, so polling works.

### 4. Repo Ownership Check for Temporal Routes
- **Location:** Existing routes use `getUserDb(req).from("repositories")` with RLS
- **Impact:** Temporal routes need the same pattern to prevent cross-tenant data access
- **Fix:** Use same `getUserDb(req)` pattern from existing routes. For Neo4j queries, filter by `repo_url` which is scoped to the user's repos.

### 5. Commit SHA Resolution for Diff
- **Location:** Diff endpoint needs to resolve SHA → timestamp for range queries
- **Impact:** Frontend sends SHAs, but Neo4j temporal queries filter by timestamp
- **Fix:** Look up commit timestamps from Supabase `commits` table, then use timestamps in Cypher queries

### 6. File List for Complexity Chart File Picker
- **Location:** No endpoint returns list of files with complexity data
- **Impact:** ComplexityTrendChart needs a file picker but doesn't know which files have metrics
- **Fix:** Add `GET /api/temporal/:repoId/complexity-files` that returns `SELECT DISTINCT file_path FROM complexity_metrics WHERE repo_id = $repoId`

## Wiring Checklist

### Phase 1: Dependencies + Route Skeleton
- [ ] Install `recharts` in `packages/frontend/`: `npm install recharts`
- [ ] Create `packages/backend/src/temporal-routes.ts` with Express Router skeleton
- [ ] Mount in `packages/backend/src/index.ts`: `app.use("/api/temporal", temporalRoutes)`
- [ ] Add auth middleware — same pattern as other route files (`getUserDb(req)`, repo ownership check via RLS)
- [ ] Verify backend compiles with new route file

### Phase 2: Backend Temporal Endpoints
- [ ] `GET /api/temporal/:repoId/commits` — query Supabase `commits` table
- [ ] `GET /api/temporal/:repoId/symbol-history` — query Neo4j for versioned symbols + INTRODUCED_IN
- [ ] `GET /api/temporal/:repoId/complexity-trend` — query Supabase `complexity_metrics`
- [ ] `GET /api/temporal/:repoId/complexity-files` — query `SELECT DISTINCT file_path FROM complexity_metrics`
- [ ] `GET /api/temporal/:repoId/structural-blame` — query Neo4j for earliest INTRODUCED_IN
- [ ] `GET /api/temporal/:repoId/diff` — query Neo4j for changes in commit range
- [ ] `POST /api/temporal/:repoId/backfill` — fire-and-forget `runHistoricalBackfill()`
- [ ] `GET /api/temporal/:repoId/backfill/status` — query `temporal_digest_jobs`
- [ ] Repo ownership guard: verify repoId belongs to authenticated user before all queries

### Phase 3: Frontend API Layer
- [ ] Define TypeScript interfaces in `api.ts`: `SymbolVersion`, `ComplexityDataPoint`, `BlameResult`, `DiffEntry`, `CommitSummary`, `BackfillJob`
- [ ] `getCommits(repoId, limit?)` → `GET /api/temporal/:repoId/commits`
- [ ] `getSymbolHistory(repoId, name, kind?, since?, limit?)` → `GET /api/temporal/:repoId/symbol-history`
- [ ] `getComplexityTrend(repoId, filePath, metric?, since?)` → `GET /api/temporal/:repoId/complexity-trend`
- [ ] `getComplexityFiles(repoId)` → `GET /api/temporal/:repoId/complexity-files`
- [ ] `getStructuralBlame(repoId, name, kind?)` → `GET /api/temporal/:repoId/structural-blame`
- [ ] `getDiffGraph(repoId, fromRef, toRef, scope?)` → `GET /api/temporal/:repoId/diff`
- [ ] `triggerBackfill(repoId, maxCommits?)` → `POST /api/temporal/:repoId/backfill`
- [ ] `getBackfillStatus(repoId)` → `GET /api/temporal/:repoId/backfill/status`

### Phase 4: Router + Sidebar Wiring
- [ ] Add `History` nav item to `Sidebar.tsx` NAV_ITEMS array (icon: `GitCommitHorizontal` from lucide-react)
- [ ] Add lazy import in `main.tsx`: `const HistoryView = lazyWithRetry(() => import("./views/HistoryView"))`
- [ ] Add route: `<Route path="history" element={<HistoryView />} />`

### Phase 5: HistoryView + Sub-Components
- [ ] Create `packages/frontend/src/views/HistoryView.tsx`
  - Repo selector dropdown (reuses `getRepositories()`)
  - Tab bar: Symbol Timeline | Complexity | Blame | Diff Explorer
  - Selected repo + tab state in URL params or local state
  - Fetches commits on repo select; shows BackfillPanel if empty
- [ ] Create `packages/frontend/src/components/temporal/SymbolTimeline.tsx`
  - Symbol search input (debounced)
  - Vertical timeline of versions: signature, change_type badge, author, commit message, timestamp
  - Empty state: "Search for a symbol to see its history"
- [ ] Create `packages/frontend/src/components/temporal/ComplexityTrendChart.tsx`
  - File picker (from `getComplexityFiles()`)
  - Metric toggle: coupling_score | import_count | reverse_import_count | symbol_count
  - Recharts `<LineChart>` with time X-axis, metric Y-axis
  - Empty state: "Select a file to view complexity trends"
- [ ] Create `packages/frontend/src/components/temporal/StructuralBlamePanel.tsx`
  - Symbol search input
  - Attribution card: "Introduced by {author} in {sha} — {message}" with timestamp
  - Empty state: "Search for a symbol to see who introduced it"
- [ ] Create `packages/frontend/src/components/temporal/DiffExplorer.tsx`
  - Two commit pickers (from/to) populated from commits list
  - Three collapsible sections: Created, Modified, Deleted
  - Each entry: symbol name, kind badge, file path, author, commit message
  - Empty state: "Select two commits to compare structural changes"
- [ ] Create `packages/frontend/src/components/temporal/BackfillPanel.tsx`
  - maxCommits input (default 50)
  - "Run Backfill" button
  - Progress bar (polls backfill status every 5s when running)
  - Completion message with stats

## Build Order

### Phase 1: Dependencies + Route Skeleton (30 min)
**Files:** `packages/frontend/package.json` (modify), `packages/backend/src/temporal-routes.ts` (new), `packages/backend/src/index.ts` (modify)
**Dependencies:** None
**Checkpoint:** Backend compiles, new routes return 501 stubs, recharts importable

### Phase 2: Backend Temporal Endpoints (2-3 hours)
**Files:** `packages/backend/src/temporal-routes.ts` (implement all 8 endpoints)
**Dependencies:** Phase 1 (route skeleton mounted)
**Checkpoint:** All endpoints return correct data when called via curl/REST client. Verify: commits list, symbol history, complexity trend, blame, diff, backfill trigger + status.

### Phase 3: Frontend API Layer (1 hour)
**Files:** `packages/frontend/src/api.ts` (add types + functions)
**Dependencies:** Phase 2 (endpoints must exist to test against)
**Checkpoint:** API functions callable from browser console, return typed data

### Phase 4: Router + Sidebar Wiring (15 min)
**Files:** `packages/frontend/src/main.tsx` (modify), `packages/frontend/src/Sidebar.tsx` (modify)
**Dependencies:** None (can use placeholder HistoryView)
**Checkpoint:** `/history` route renders, sidebar nav item appears and highlights when active

### Phase 5: HistoryView + Sub-Components (3-4 hours)
**Files:** `packages/frontend/src/views/HistoryView.tsx` (new), 5 new components in `packages/frontend/src/components/temporal/`
**Dependencies:** Phase 3 (API functions), Phase 4 (route wired)
**Checkpoint:** All 4 tabs render with data from backend. Empty states work for repos without temporal data. Backfill trigger starts a job and shows progress.

### Total: ~7-9 hours across 5 phases
