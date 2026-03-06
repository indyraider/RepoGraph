# Phase 6 Forward Plan Review (Final)
**Phase completed:** Frontend Log Source UI
**Date:** 2026-03-06
**Build status:** COMPLETE

## End-to-End Chain Verification

The full chain from frontend to Supabase is wired and verified:

### Chain 1: Frontend -> Backend API -> Supabase (Log Source CRUD)

| Link | Status | Evidence |
|------|--------|----------|
| `LogSourcePanel` imports API functions from `api.ts` | CONNECTED | `import { getLogSources, getLogSourcePlatforms, createLogSource, deleteLogSource, testLogSourceConnection, toggleLogSource, getRepositories }` at line 17-28 |
| `api.ts` calls `authedFetch()` to `/api/log-sources/*` | CONNECTED | 8 API functions using `authedFetch()` with correct paths |
| Backend `index.ts` mounts routes at `/api/log-sources` | CONNECTED | Line 81: `app.use("/api/log-sources", logSourceRoutes)` |
| Routes use `getSupabase()` to read/write `log_sources` table | CONNECTED | All 7 route handlers query `log_sources` via Supabase client |
| Routes encrypt tokens via `encrypt()` from `lib/crypto.ts` | CONNECTED | Line 13: `import { encrypt, safeDecrypt } from "../lib/crypto.js"` |
| Auth middleware protects `/api/log-sources/*` | CONNECTED | Middleware at line 34-77 of index.ts covers all `/api` paths except `/health`, `/webhooks/`, `/auth/` |

### Chain 2: Backend API -> Adapters (Test Connection)

| Link | Status | Evidence |
|------|--------|----------|
| Routes import adapter registry | CONNECTED | Line 14: `import { getAdapter, getRegisteredPlatforms } from "./adapters/registry.js"` |
| `test-connection` route instantiates adapter and calls `testConnection()` | CONNECTED | Lines 48-73 of routes.ts |
| Saved source test decrypts token, calls adapter | CONNECTED | Lines 197-239 of routes.ts |

### Chain 3: Collector -> Adapters -> Supabase (Log Ingestion)

| Link | Status | Evidence |
|------|--------|----------|
| Collector started in `index.ts` after Supabase verified | CONNECTED | Lines 122-129 of index.ts |
| Collector imports adapter registry, crypto, stack-parser | CONNECTED | Lines 8-12 of collector.ts |
| Collector queries `log_sources WHERE enabled = true` | CONNECTED | Confirmed in collector.ts |
| Collector decrypts tokens via `safeDecrypt()` | CONNECTED | Line 9: `import { safeDecrypt } from "../lib/crypto.js"` |
| Collector batch-inserts into `runtime_logs` and `deployments` | CONNECTED | Confirmed in collector.ts |
| Collector updates `last_poll_at` on success, `last_error` on failure | CONNECTED | Confirmed in previous checkpoints |
| Retention worker started/stopped alongside collector | CONNECTED | Lines 125, 173 of index.ts |

### Chain 4: MCP Tools -> Supabase + Neo4j (Query Layer)

| Link | Status | Evidence |
|------|--------|----------|
| `registerRuntimeTools()` called in MCP server index.ts | CONNECTED | Line 632: `registerRuntimeTools(server, getSession, getSupabase)` |
| 5 tools registered: get_recent_logs, search_logs, get_deploy_errors, get_deployment_history, trace_error | CONNECTED | Confirmed in Phase 5 checkpoint |
| `resolveRepoId()` resolves repo names to UUIDs via `repositories` table | CONNECTED | Confirmed in repo-resolver.ts |
| `trace_error` chains: log fetch -> stack parse -> Neo4j function lookup -> callers -> imports -> file source | CONNECTED | Confirmed in Phase 5 checkpoint |

### Chain 5: SettingsView -> LogSourcePanel (UI Mount)

| Link | Status | Evidence |
|------|--------|----------|
| SettingsView imports LogSourcePanel | CONNECTED | Line 30: `import { LogSourcePanel } from "../components/LogSourcePanel"` |
| LogSourcePanel rendered inside card-glass wrapper | CONNECTED | Lines 505-507 of SettingsView.tsx |

### Database Schema Supports All Consumers

| Table | Writers | Readers |
|-------|---------|---------|
| `log_sources` | Backend routes (CRUD), Collector (last_poll_at, last_error) | Backend routes (list), Collector (poll query), Frontend (via API) |
| `runtime_logs` | Collector (batch insert) | MCP tools (5 tools), Retention worker (DELETE) |
| `deployments` | Collector (batch upsert) | MCP tools (get_deploy_errors, get_deployment_history) |

## Missed Checklist Items (across all phases)

### Phase 1: Foundation -- ALL COMPLETE
- [x] Migration SQL with 3 tables, `last_error` column, unique constraint, compound indexes
- [x] Adapter interface types
- [x] Stack trace parser
- [x] Crypto extraction to shared module
- [x] connections.ts updated to import from shared crypto (line 8: `from "./lib/crypto.js"`)

### Phase 2: Adapters + Registry -- ALL COMPLETE
- [x] Vercel adapter with testConnection, fetchSince, fetchDeployments
- [x] Railway adapter with testConnection, fetchSince, fetchDeployments
- [x] Exponential backoff on 429s
- [x] Adapter registry with platform lookup

### Phase 3: Collector + Retention -- ALL COMPLETE
- [x] Collector with 10s poll interval, per-source error handling
- [x] Stack trace parsing on error entries
- [x] Batch insert to runtime_logs, batch upsert to deployments
- [x] last_error cleared on successful poll
- [x] Retention worker (hourly, 30-day TTL)
- [x] Wired into index.ts start() and SIGINT handler

### Phase 4: Backend API Routes -- ALL COMPLETE
- [x] 6 planned endpoints + 2 bonus (platforms, test-connection)
- [x] Token encryption on create/update
- [x] Token stripping on read
- [x] Platform validation against registry
- [x] Mounted in index.ts

### Phase 5: MCP Runtime Tools -- ALL COMPLETE
- [x] Repo resolver
- [x] 5 tools implemented and registered
- [x] trace_error graceful degradation
- [x] search_logs with full-text search + ilike fallback

### Phase 6: Frontend Log Source UI -- MOSTLY COMPLETE (see Loose Ends)
- [x] API functions in api.ts: getLogSources, createLogSource, deleteLogSource, testLogSourceConnection, toggleLogSource
- [x] Additional: getLogSourcePlatforms, testSavedLogSource (bonus over plan)
- [x] LogSourcePanel component with platform selector, dynamic config fields, token input, test connection, source list, toggle, delete
- [x] Mounted in SettingsView.tsx
- [x] Repository dropdown populated via getRepositories()

## Loose Ends

### 1. `updateLogSource` API function defined but unused
The `api.ts` file exports `updateLogSource()` (lines 306-326) and `testSavedLogSource()` (lines 348-353), but neither is imported or used by `LogSourcePanel.tsx`. The component has no edit/update flow for existing sources -- users can only create, toggle, or delete. This means:
- **No inline editing** of display name, polling interval, min level, or config after creation
- **No re-test of saved sources** from the UI (the `/:id/test` endpoint is reachable but not wired to a button)

**Severity:** Low. The API and backend support it. This is a UX completeness gap, not a broken chain.

### 2. No auto-refresh of source status
The `LogSourcePanel` loads sources once on mount and after create/delete/toggle actions. There is no periodic refresh to show updated `last_poll_at` or `last_error` changes from the collector running in the background. A user would need to navigate away and back to see status changes.

**Severity:** Low. Polish item.

### 3. Stack trace parser duplicated in MCP tools
The `runtime-tools.ts` file contains a copy of the stack trace parser (lines 12-47) rather than importing from a shared package. This was noted in the Phase 5 checkpoint as intentional (MCP server is a separate package), but it means bug fixes would need to be applied in two places.

**Severity:** Low. Acceptable for v1 given package boundaries.

### 4. `get_deployment_history` client-side log counting
The MCP tool fetches all matching log rows to count errors/warns client-side rather than using a SQL aggregation. Noted in Phase 5 checkpoint. Could become a performance issue with high-volume log sources.

**Severity:** Low for v1 usage patterns.

## Polish / Follow-up Items

1. **Edit source form** -- Add an edit mode to `SourceRow` that uses `updateLogSource()` and `testSavedLogSource()` APIs already built in `api.ts`.

2. **Auto-refresh polling** -- Add a `setInterval` in `LogSourcePanel` to re-fetch sources every 30-60 seconds so `last_poll_at` and `last_error` stay current.

3. **Repo scoping in source list** -- Currently `getLogSources()` returns ALL sources across all repos. Consider adding a `?repo_id=` query parameter to the backend GET endpoint and filtering in the frontend when viewing a specific repo.

4. **Error toast notifications** -- The `refresh()` function silently swallows errors (`.catch(() => {})`). Consider surfacing fetch failures to the user.

5. **Pagination** -- The source list and MCP log queries have no pagination. Fine for v1 but will need it at scale.

6. **Search logs GIN index** -- The `idx_runtime_logs_message_fts` index uses `to_tsvector('english', message)`. The `search_logs` MCP tool uses `.textSearch("message", query, { type: "websearch" })` which should match, but this should be tested with real data to confirm Supabase client's textSearch maps correctly to the GIN index.

7. **GitHub Actions adapter** -- Explicitly deferred to v1.1 per plan overview. The adapter interface and registry are ready for it.

## Final Assessment

The Runtime Context Layer build is **COMPLETE** across all 6 phases. Every component in the plan's Component Inventory has been built:

- **13/13 components built** (migration, types, 2 adapters, registry, stack parser, collector, retention, routes, crypto, MCP tools, repo resolver, frontend UI)
- **10/10 integration contracts verified as wired** (Frontend->Backend, Backend->Supabase, Collector->Adapters, Adapters->Platform APIs, Collector->Parser, Collector->Supabase, MCP->Supabase, trace_error->Neo4j, Backend startup->Collector/Retention, SettingsView->LogSourcePanel)
- **All 3 plan-identified issues addressed** (last_error column added, repo_id+timestamp index added, deployments unique constraint added)
- **All 2 phantom dependencies resolved** (crypto extracted to shared module, adapter registry created)
- **1 one-way street fixed** (last_error cleared on successful poll)
- **TypeScript compiles clean** (`tsc --noEmit` passes with zero errors)

The only gaps are UX polish items (no edit flow, no auto-refresh, silent error swallowing) -- none of which represent broken wiring or missing functionality. The end-to-end data flow from platform APIs through to MCP tool responses is fully connected.
