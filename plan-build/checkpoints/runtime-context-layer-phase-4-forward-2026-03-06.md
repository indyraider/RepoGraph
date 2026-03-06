# Phase 4 Forward Plan — Runtime Context Layer
**Date:** 2026-03-06
**Phase completed:** Phase 4 (Backend API Routes)
**Remaining:** Phase 5 (MCP Runtime Tools), Phase 6 (Frontend UI)

## Extracted API Surface

### Endpoints in routes.ts (mounted at `/api/log-sources`)

| Method | Path | Request Body | Response Shape |
|--------|------|-------------|----------------|
| GET | `/` | — | `Array<{id, repo_id, platform, display_name, config (no token), polling_interval_sec, min_level, enabled, last_poll_at, last_error, created_at}>` |
| GET | `/platforms` | — | `Array<{platform: string, displayName: string}>` |
| POST | `/` | `{repo_id, platform, display_name, api_token, config?, polling_interval_sec?, min_level?}` | `201` with full row (token stripped) |
| PUT | `/:id` | `{display_name?, api_token?, config?, polling_interval_sec?, min_level?}` | Full row (token stripped) |
| DELETE | `/:id` | — | `{ok: true}` |
| POST | `/:id/test` | — | `ConnectionResult` from adapter: `{ok, error?, meta?}` |
| POST | `/test-connection` | `{platform, api_token, config?}` | `ConnectionResult` from adapter: `{ok, error?, meta?}` |
| POST | `/:id/toggle` | — | `{id, enabled}` (partial row) |

### ConnectionResult type (from Phase 1 types.ts)

```typescript
{ ok: boolean; error?: string; meta?: { latestLogTimestamp?: string; entryCount?: number } }
```

## Mismatch Analysis

### Plan vs Implementation — GET list response

**Plan says:**
```
{ id, repo_id, platform, display_name, config, polling_interval_sec, min_level, enabled, last_poll_at, last_error }[]
```

**Implementation returns:** `SELECT *` from log_sources, minus `config.encrypted_api_token`. This means the response also includes `created_at` (and any other DB columns). This is a superset — **no conflict**, frontend just ignores extra fields.

**MATCH: OK** — all fields the plan specifies are present.

### Plan vs Implementation — test-connection

**Plan says (Flow 1, step 7):** `POST /api/log-sources/test-connection` with body `{ platform, api_token, config }`. Returns `{ ok: true, ... }`.

**Implementation:** Route exists at `POST /test-connection` (line 207). Takes `{ platform, api_token, config }`. Calls `adapter.testConnection()` which returns `ConnectionResult { ok, error?, meta? }`.

**MATCH: OK** — plan's `{ ok: true, latestLog: "..." }` (step 10) is slightly loose but `ConnectionResult.meta.latestLogTimestamp` covers it.

### Plan vs Implementation — POST /api/log-sources/:id/test

**Plan says:** `POST /api/log-sources/:id/test` — invoke adapter.testConnection(), return result.

**Implementation:** Route at line 165. Fetches source from DB, decrypts token, calls `adapter.testConnection(adapterConfig)`, returns result directly.

**MATCH: OK**

### Plan vs Implementation — POST create response

**Plan (Flow 1, step 16):** Says `{ id: "...", status: "saved" }`.

**Implementation (line 89):** Returns `201` with the full row (minus encrypted token). No `status: "saved"` field.

**MINOR MISMATCH** — The plan's `{ id, status: "saved" }` is informal shorthand. The implementation returns the full object with `id` included. Frontend can use `id` from response. **No action needed** — the plan's phrasing was descriptive, not prescriptive.

### Bonus endpoint: GET /platforms

**Not in plan.** Implementation adds `GET /api/log-sources/platforms` returning registered adapters. This is useful for Phase 6 frontend (platform dropdown). **No conflict, beneficial addition.**

## Phase 5 (MCP Runtime Tools) — Conflict Check

Phase 5 tools query Supabase tables directly (runtime_logs, deployments). They do NOT call these HTTP routes. Verified:
- No route path overlap — MCP tools don't expose `/api/log-sources/*` endpoints
- Data compatibility: the collector writes `repo_id`, `source`, `level`, `timestamp`, `deployment_id`, `file_path`, `line_number`, `stack_trace`, `metadata` to `runtime_logs` — these are exactly the columns MCP tools will query
- The collector's camelCase-to-snake_case mapping (lines 147-159 of collector.ts) correctly produces the DB column names that MCP queries will use

**No conflicts.**

## Phase 6 (Frontend UI) — Dependency Readiness

The frontend needs these API calls (from plan):
- `getLogSources()` → GET `/api/log-sources` — **available, returns array**
- `createLogSource()` → POST `/api/log-sources` — **available**
- `updateLogSource()` → PUT `/api/log-sources/:id` — **available**
- `deleteLogSource()` → DELETE `/api/log-sources/:id` — **available, returns `{ok: true}`**
- `testLogSourceConnection()` → POST `/api/log-sources/test-connection` — **available**
- `toggleLogSource()` → POST `/api/log-sources/:id/toggle` — **available, returns `{id, enabled}`**

**Frontend note:** The toggle endpoint returns only `{id, enabled}`, not the full object. The frontend should update just the `enabled` field in local state after toggle, not replace the entire source object.

**Platforms endpoint:** The bonus `GET /platforms` endpoint lets the frontend dynamically render the platform dropdown rather than hardcoding platform names.

## Collector ↔ Routes Data Compatibility

Routes write to `log_sources` table. Collector reads from `log_sources` table. Verified:
- Routes store encrypted token at `config.encrypted_api_token` (line 62-63 of routes.ts)
- Collector reads from `config.encrypted_api_token` (line 99 of collector.ts)
- Routes set `enabled: true` on create (line 76)
- Collector filters `WHERE enabled = true` (line 56)
- Routes default `polling_interval_sec: 30`, `min_level: "warn"` — collector uses both fields

**Full compatibility confirmed.**

## Issues

### None blocking

All endpoints match what Phase 5 and Phase 6 need. The only deviation from the plan is the create response shape (full row vs `{id, status}`), which is strictly better for the frontend.

## Verdict

**Phase 4 is ready. Proceed to Phase 5.**
