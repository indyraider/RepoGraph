# Brainstorm: Runtime Logs Viewer

**Created:** 2026-03-07
**Status:** Draft

## Vision

Build a frontend view that lets humans browse, search, and filter runtime log entries collected from connected deployment platforms (Vercel, Railway). Logs are already being ingested into Supabase's `runtime_logs` table by the collector and are queryable via MCP tools — but there's no REST API to expose them and no UI for humans to see them. This is the missing "last mile" between log collection and human visibility.

## Existing Context

### What already exists

1. **Log Collector** (`packages/backend/src/runtime/collector.ts`)
   - Polls enabled log sources on a 10s interval
   - Calls platform adapters (Vercel, Railway) to fetch logs
   - Parses stack traces on error entries
   - Batch-inserts into Supabase `runtime_logs` table
   - Also upserts deployments into `deployments` table

2. **runtime_logs table schema** (inferred from collector insert):
   - `id` (auto)
   - `repo_id` (FK)
   - `source` (platform: "vercel", "railway")
   - `level` ("info", "warn", "error")
   - `message` (text)
   - `timestamp` (timestamptz)
   - `deployment_id` (nullable)
   - `function_name` (nullable)
   - `file_path` (nullable — parsed from stack traces)
   - `line_number` (nullable)
   - `stack_trace` (nullable)
   - `metadata` (jsonb)

3. **deployments table** (inferred from collector upsert):
   - `repo_id`, `source`, `deployment_id`, `status`, `branch`, `commit_sha`, `started_at`, `completed_at`, `url`

4. **MCP tools** (`packages/mcp-server/src/runtime-tools.ts`) — 5 tools that query these tables:
   - `get_recent_logs` — time-windowed fetch with source/level filters
   - `search_logs` — full-text search (textSearch with ilike fallback)
   - `get_deploy_errors` — errors scoped to recent deployments
   - `get_deployment_history` — deployment timeline with error/warn counts
   - `trace_error` — stack trace parsing + Neo4j code graph lookup

5. **Log Source Management UI** (`packages/frontend/src/components/LogSourcePanel.tsx`)
   - Add/remove/toggle/test Vercel/Railway sources
   - Lives in Settings view — manages sources, NOT logs

6. **Activity Log View** (`packages/frontend/src/views/ActivityLogView.tsx`)
   - Shows sync events and digest jobs (pipeline activity)
   - NOT runtime logs

7. **Backend log source routes** (`packages/backend/src/runtime/routes.ts`)
   - CRUD + test + toggle for log sources
   - Mounted at `/api/log-sources`
   - NO routes for querying actual log entries

8. **Retention worker** (`packages/backend/src/runtime/retention.ts`)
   - Prunes logs older than 30 days, checks hourly

### Frontend architecture
- React + React Router, lazy-loaded views
- Sidebar nav: Dashboard, Explore Graph, Activity Log, Settings
- Auth via Supabase (or API key fallback)
- API calls via `packages/frontend/src/api.ts` with `authedFetch`
- Design: dark theme, glass cards, violet accents, Lucide icons

## Components Identified

### 1. Backend: Runtime Logs API Routes
- **Responsibility**: Expose `runtime_logs` and `deployments` tables via REST API
- **Upstream (receives from)**: Supabase `runtime_logs` + `deployments` tables (populated by collector)
- **Downstream (sends to)**: Frontend RuntimeLogsView via fetch
- **External dependencies**: Supabase client (already available via `getSupabase()`)
- **Hands test**: PASS — Supabase queries are straightforward; MCP tools already prove the query patterns work

### 2. Frontend: api.ts extensions
- **Responsibility**: Add typed fetch functions for the new log endpoints
- **Upstream (receives from)**: Backend REST API
- **Downstream (sends to)**: RuntimeLogsView component
- **External dependencies**: None beyond existing `authedFetch`
- **Hands test**: PASS — follows exact same pattern as existing API functions

### 3. Frontend: RuntimeLogsView
- **Responsibility**: Full-page view for browsing/searching/filtering runtime logs
- **Upstream (receives from)**: api.ts log fetch functions
- **Downstream (sends to)**: User (display only)
- **External dependencies**: Lucide icons (already in deps), existing UI patterns
- **Hands test**: PASS — pure display component

### 4. Frontend: Route + Nav wiring
- **Responsibility**: Add `/logs` route to main.tsx and nav item to Sidebar
- **Upstream (receives from)**: React Router
- **Downstream (sends to)**: RuntimeLogsView lazy load
- **External dependencies**: None
- **Hands test**: PASS — trivial wiring

## Rough Dependency Map

```
Supabase runtime_logs table
        |
        v
[Backend: Log query routes]  (/api/runtime-logs)
        |
        v
[Frontend: api.ts]  (getRuntimeLogs, searchRuntimeLogs, getDeployments)
        |
        v
[Frontend: RuntimeLogsView]  (/logs route)
        ^
        |
[Frontend: Sidebar nav + main.tsx route]
```

Build order: Backend routes -> api.ts functions -> RuntimeLogsView -> Route/nav wiring

## Open Questions

1. **Search approach**: The MCP uses `textSearch` with `ilike` fallback. Should the API do the same, or just use `ilike` for simplicity? (Recommendation: match MCP — try textSearch, fallback to ilike)
2. **Pagination**: MCP tools use simple `limit`. Should the UI use cursor pagination or offset pagination? (Recommendation: offset pagination with page size selector — logs are time-ordered so offset is fine)
3. **Auto-refresh**: Should the log view auto-poll for new entries? (Recommendation: yes, optional toggle, 15-30s interval)
4. **Stack trace display**: Show inline expandable or modal? (Recommendation: inline expandable, same pattern as ActivityLogView's expandable events)

## Risks and Concerns

1. **Table size**: `runtime_logs` could get large. Need pagination and time-range filtering to avoid slow queries. The 30-day retention worker caps growth.
2. **Full-text search availability**: Depends on whether a GIN index exists on `runtime_logs.message`. The MCP already handles this with ilike fallback — API should do the same.
3. **No new infrastructure needed**: All data is already in Supabase, all auth patterns are established. This is purely additive code.
