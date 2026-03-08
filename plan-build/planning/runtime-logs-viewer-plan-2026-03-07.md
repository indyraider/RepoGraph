# Build Plan: Runtime Logs Viewer

**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/runtime-logs-viewer-brainstorm-2026-03-07.md
**Status:** Draft

## Overview

Add a Runtime Logs view to the RepoGraph frontend that lets users browse, search, and filter production log entries collected from Vercel/Railway. Requires new backend API routes (the data already exists in Supabase `runtime_logs` and `deployments` tables), new frontend API functions, a new view component, and route/nav wiring.

## Component Inventory

| Component | Type | Inputs | Outputs | Dependencies |
|-----------|------|--------|---------|-------------|
| Log query routes | Backend (Express) | HTTP requests + Supabase | JSON responses | `getSupabase()`, auth middleware |
| api.ts extensions | Frontend (TS) | Backend responses | Typed data | `authedFetch()` |
| RuntimeLogsView | Frontend (React) | api.ts functions | Rendered UI | React, Lucide icons, api.ts |
| Route + Nav wiring | Frontend (React) | React Router | Mounted view | main.tsx, Sidebar.tsx |

## Integration Contracts

### 1. Backend Routes -> Supabase

**GET /api/runtime-logs/:repoId**
```
Query params:
  level?:     "info" | "warn" | "error"
  source?:    "vercel" | "railway"
  search?:    string (message text search)
  since?:     ISO 8601 timestamp
  until?:     ISO 8601 timestamp
  page?:      number (default: 1)
  pageSize?:  number (default: 50, max: 200)

Response: {
  entries: RuntimeLogEntry[],
  total: number,
  page: number,
  pageSize: number
}

RuntimeLogEntry: {
  id: string
  repo_id: string
  source: string
  level: string
  message: string
  timestamp: string
  deployment_id: string | null
  function_name: string | null
  file_path: string | null
  line_number: number | null
  stack_trace: string | null
  metadata: Record<string, unknown>
}

Auth: Bearer token (Supabase session or API key) — handled by existing middleware
Error: 500 { error: string }
```

**GET /api/runtime-logs/:repoId/stats**
```
Query params:
  since?:  ISO 8601 timestamp (default: 24h ago)
  until?:  ISO 8601 timestamp

Response: {
  total: number
  byLevel: { info: number, warn: number, error: number }
  bySource: Record<string, number>
}

Error: 500 { error: string }
```

### 2. Frontend api.ts -> Backend

Functions to add:
```typescript
interface RuntimeLogEntry { /* matches backend response */ }
interface RuntimeLogPage {
  entries: RuntimeLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}
interface RuntimeLogStats {
  total: number;
  byLevel: { info: number; warn: number; error: number };
  bySource: Record<string, number>;
}

getRuntimeLogs(repoId, filters): Promise<RuntimeLogPage>
getRuntimeLogStats(repoId, since?, until?): Promise<RuntimeLogStats>
```

### 3. RuntimeLogsView -> api.ts

- Calls `getRepositories()` (existing) to populate repo selector
- Calls `getRuntimeLogs()` with filters on load and filter change
- Calls `getRuntimeLogStats()` for summary badges
- Renders entries in a list with expandable stack traces
- Auto-refresh toggle (15s interval via setInterval)

### 4. Route + Nav -> RuntimeLogsView

- `main.tsx`: Add lazy import + `<Route path="logs" element={<RuntimeLogsView />} />`
- `Sidebar.tsx`: Add nav item `{ to: "/logs", icon: ScrollText, label: "Runtime Logs" }` between Activity Log and Settings

## End-to-End Flows

### Primary: User browses recent error logs
```
1. User clicks "Runtime Logs" in sidebar
2. React Router mounts RuntimeLogsView at /logs
3. Component calls getRepositories() -> GET /api/repositories
4. Component calls getRuntimeLogs(repoId, { level: "error" }) -> GET /api/runtime-logs/:repoId?level=error
5. Backend queries Supabase: runtime_logs WHERE repo_id = $1 AND level = 'error' ORDER BY timestamp DESC LIMIT 50
6. Response: { entries: [...], total: 42, page: 1, pageSize: 50 }
7. UI renders log entry list with red error styling
8. User clicks entry with stack_trace -> expands inline
```

### Search flow
```
1. User types "TypeError" in search box, hits enter/debounce
2. Component calls getRuntimeLogs(repoId, { search: "TypeError" })
3. Backend tries textSearch("message", query, { type: "websearch" })
4. If textSearch fails, falls back to ilike("%TypeError%")
5. Results rendered with search term context
```

### Auto-refresh flow
```
1. User enables auto-refresh toggle
2. setInterval(15000) calls getRuntimeLogs with current filters
3. New entries prepended to list (compare by id to avoid duplicates)
4. Toggle off clears interval
```

### Error paths
```
- Backend Supabase query fails -> 500 { error } -> UI shows error banner with retry button
- No logs found -> UI shows empty state with "No logs in this time range"
- No repos exist -> UI shows "No repositories" empty state (same as ActivityLogView)
- Auth fails -> 401 -> existing auth middleware handles redirect
```

## Issues Found

None. This is a clean additive build:
- No phantom dependencies: Supabase tables exist, GIN index exists for full-text search, auth middleware exists
- No dead ends: every component has both an input source and an output consumer
- No permission gaps: uses same auth pattern as all other routes
- No missing sources: `runtime_logs` table is populated by the existing collector

## Wiring Checklist

### Phase 1: Backend Routes
- [ ] Create `packages/backend/src/runtime/log-routes.ts` with Express router
- [ ] Implement `GET /` (list logs with pagination + filters)
- [ ] Implement `GET /stats` (aggregated counts by level/source)
- [ ] Use textSearch with ilike fallback for search param (match MCP pattern)
- [ ] Mount at `/api/runtime-logs` in `packages/backend/src/index.ts` (after auth middleware)

### Phase 2: Frontend API
- [ ] Add `RuntimeLogEntry` interface to `packages/frontend/src/api.ts`
- [ ] Add `RuntimeLogPage` interface
- [ ] Add `RuntimeLogStats` interface
- [ ] Add `getRuntimeLogs(repoId, filters)` function
- [ ] Add `getRuntimeLogStats(repoId, since?, until?)` function

### Phase 3: RuntimeLogsView Component
- [ ] Create `packages/frontend/src/views/RuntimeLogsView.tsx`
- [ ] Repo selector (reuse pattern from ActivityLogView)
- [ ] Filter controls: level toggle buttons, source filter, time range, search input
- [ ] Stats summary bar (total, errors, warns, by source)
- [ ] Log entry list with level-colored indicators
- [ ] Expandable stack trace display on error entries
- [ ] File path + line number display on entries with parsed locations
- [ ] Pagination controls (prev/next + page size)
- [ ] Auto-refresh toggle with 15s interval
- [ ] Loading, error, and empty states

### Phase 4: Route + Nav Wiring
- [ ] Add lazy import in `packages/frontend/src/main.tsx`
- [ ] Add Route at path "logs"
- [ ] Add nav item in `packages/frontend/src/Sidebar.tsx` (ScrollText icon)

## Build Order

1. **Phase 1: Backend Routes** — no frontend dependencies, can be tested via curl
2. **Phase 2: Frontend API** — depends on Phase 1 response shapes
3. **Phase 3: RuntimeLogsView** — depends on Phase 2 functions
4. **Phase 4: Route + Nav Wiring** — depends on Phase 3 component existing
