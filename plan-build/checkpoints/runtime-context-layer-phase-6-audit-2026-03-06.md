# Phase 6 Audit: Frontend Log Source UI
**Date:** 2026-03-06
**Phase:** 6 -- Frontend Log Source UI
**Files audited:**
- `packages/frontend/src/api.ts` (lines 252-361, Log Sources API section)
- `packages/frontend/src/components/LogSourcePanel.tsx` (full file, 529 lines)
- `packages/frontend/src/views/SettingsView.tsx` (full file, 511 lines)
- `packages/backend/src/runtime/routes.ts` (full file, 273 lines, contract verification)
- `packages/backend/src/runtime/adapters/registry.ts` (full file, 30 lines, return shape verification)

---

## Verified Connections

### API Functions in api.ts (all 7 present and correctly wired)

| Function | Method | URL | Backend Route | Match |
|---|---|---|---|---|
| `getLogSources()` | GET | `/api/log-sources` | `router.get("/")` | YES |
| `getLogSourcePlatforms()` | GET | `/api/log-sources/platforms` | `router.get("/platforms")` | YES |
| `createLogSource(params)` | POST | `/api/log-sources` | `router.post("/")` | YES |
| `updateLogSource(id, params)` | PUT | `/api/log-sources/:id` | `router.put("/:id")` | YES |
| `deleteLogSource(id)` | DELETE | `/api/log-sources/:id` | `router.delete("/:id")` | YES |
| `testLogSourceConnection(params)` | POST | `/api/log-sources/test-connection` | `router.post("/test-connection")` | YES |
| `testSavedLogSource(id)` | POST | `/api/log-sources/${id}/test` | `router.post("/:id/test")` | YES |
| `toggleLogSource(id)` | POST | `/api/log-sources/${id}/toggle` | `router.post("/:id/toggle")` | YES |

### Request/Response Contract Verification

1. **createLogSource** sends `{ repo_id, platform, display_name, api_token, config, polling_interval_sec, min_level }`. Backend route destructures the same fields at line 77. Required fields match: backend requires `repo_id, platform, display_name, api_token` (line 80); frontend gate `canSave` checks `repoId && platform && displayName && apiToken` (line 119). MATCH.

2. **testLogSourceConnection** sends `{ platform, api_token, config }`. Backend route destructures `{ platform, api_token, config }` at line 49, requires `platform` and `api_token` (line 51). Frontend gate `canTest` checks `platform && apiToken` (line 118). MATCH.

3. **toggleLogSource** response shape: backend returns `{ id, enabled }` from `.select("id, enabled")` (line 262). Frontend expects `{ id: string; enabled: boolean }` in the type and uses `result.enabled` at line 458. MATCH.

4. **deleteLogSource** response: backend returns `{ ok: true }` (line 193). Frontend ignores response body, just checks `!res.ok` for error (line 332). COMPATIBLE.

### TypeScript Interface: LogSource

Frontend `LogSource` interface fields (api.ts lines 254-266):
- `id`, `repo_id`, `platform`, `display_name`, `config`, `enabled`, `polling_interval_sec`, `min_level`, `last_poll_at`, `last_error`, `created_at`

Backend GET `/` returns all columns from `log_sources` via `.select("*")` (line 24), with `encrypted_api_token` stripped from `config` (lines 33-34). All interface fields are standard Supabase columns that will be present. `created_at` is included in the frontend interface and will come from Supabase's default column. MATCH.

### LogSourcePlatform Interface

Frontend: `{ platform: string; displayName: string }` (api.ts lines 268-271).
Backend `getRegisteredPlatforms()` returns `Array<{ platform: string; displayName: string }>` (registry.ts lines 22-29). EXACT MATCH.

### Token Security

- Backend strips `encrypted_api_token` from config on ALL read paths: GET list (line 34), POST create response (line 120-121), PUT update response (line 176-177).
- Frontend `LogSource.config` is typed as `Record<string, unknown>` -- will never contain `encrypted_api_token` since backend strips it.
- API token input is `type="password"` by default with show/hide toggle (LogSourcePanel.tsx line 181). CORRECT.
- Backend strips incoming `encrypted_api_token` from config on create (line 93) and update (line 151) to prevent injection. CORRECT.

### Component Mount in SettingsView

- `LogSourcePanel` imported at line 30: `import { LogSourcePanel } from "../components/LogSourcePanel";`
- Rendered at lines 505-507 inside a `card-glass` container, after the MCP Configuration card (line 499-502).
- LogSourcePanel is a named export (`export function LogSourcePanel`) at line 432. Import uses named import. MATCH.

### Backend Route Mounting

- Routes imported at line 12 of index.ts: `import logSourceRoutes from "./runtime/routes.js";`
- Mounted at line 81: `app.use("/api/log-sources", logSourceRoutes);`
- routes.ts uses `export default router`. CORRECT.

### All Buttons Traced to Handlers

| Button | Location | Handler | API Call | Result |
|---|---|---|---|---|
| "Add Source" | LogSourcePanel line 481 | `setShowAdd(true)` | -- (opens form) | WORKS |
| "Test Connection" | AddSourceForm line 264 | `handleTest()` | `testLogSourceConnection()` | WORKS |
| "Create" | AddSourceForm line 272 | `handleSave()` | `createLogSource()` | WORKS |
| "Cancel" | AddSourceForm line 280 | `onCancel()` | -- (closes form) | WORKS |
| Enable/Disable toggle | SourceRow line 373 | `handleToggle()` -> `onToggle()` | `toggleLogSource()` | WORKS |
| "Delete" | SourceRow line 391 | opens confirm | -- | WORKS |
| "Yes, delete" | SourceRow line 405 | `onDelete()` | `deleteLogSource()` | WORKS |
| "Cancel" (delete) | SourceRow line 414 | `setConfirmDelete(false)` | -- | WORKS |

### Loading States

- Initial load: `loading` state starts `true`, shows spinner with "Loading log sources..." (lines 491-495). Set to `false` in `.finally()` (line 448). CORRECT.
- Test Connection: `testing` state disables button, shows spinner (line 269). Reset in `finally` (line 93). CORRECT.
- Create: `saving` state disables button, shows spinner (line 277). Reset in `finally` (line 114). CORRECT.
- Toggle: `toggling` state disables button, shows spinner (lines 381-383). Reset in `finally` (line 309). CORRECT.

### Error Display

- Create form errors: caught in `handleSave`, displayed via `error` state (lines 256-260). CORRECT.
- Test connection failures: caught in `handleTest`, displayed via `testResult` (lines 243-254). CORRECT.
- Toggle/delete errors: NOT caught -- see Broken Chains below.

### Empty States

- No sources: Shows helpful text "No log sources configured..." (lines 510-514). CORRECT.
- No repos: The repo dropdown renders with just the "Select repo..." placeholder option. The `canSave` gate prevents saving without a repo. GRACEFUL.
- Load failure: `refresh()` has `.catch(() => {})` (line 447) which silently swallows errors and sets `loading = false`. The user sees no sources and no error message. See Broken Chains.

---

## Stubs & Placeholders Found

NONE. All functions contain real implementation code. No TODO comments, no placeholder returns, no hardcoded mock data.

---

## Broken Chains

### BC-1: `updateLogSource` is defined in api.ts but never called from the UI (MEDIUM)

The plan checklist item explicitly requires `updateLogSource`. The function exists in `api.ts` (lines 306-326) and the backend PUT route exists (routes.ts lines 125-179). However, `LogSourcePanel.tsx` does NOT import or use `updateLogSource` -- it is not in the import list (line 2-28). There is no edit/update UI anywhere in the component. Users can create and delete sources but cannot edit display name, polling interval, min level, or rotate API tokens without deleting and recreating.

**Impact:** Users must delete and recreate a source to change any configuration. This loses the `last_poll_at` timestamp and creates a gap in log collection.

### BC-2: `testSavedLogSource` is defined in api.ts but never called from the UI (LOW)

The function at api.ts line 348-353 calls `POST /api/log-sources/:id/test`, and the backend route exists (routes.ts lines 197-240). However, `LogSourcePanel.tsx` does not import `testSavedLogSource`. Once a source is saved, there is no way to re-test its connection from the UI. The only test button is in the AddSourceForm (pre-save).

**Impact:** If a token expires or platform config changes, the user has no way to verify the connection is still valid other than checking the status indicator passively.

### BC-3: Toggle and delete errors are unhandled in LogSourcePanel (LOW)

In `LogSourcePanel` (lines 455-464):
- `handleToggle` calls `toggleLogSource(id)` with no try/catch. If the API call fails, the promise rejects unhandled.
- `handleDelete` calls `deleteLogSource(id)` with no try/catch. Same issue.
- The `SourceRow` component's `handleToggle` wrapper (lines 304-309) has a `finally` block but no `catch`, so errors propagate up unhandled.

**Impact:** If toggle or delete fails (network error, 404, 500), the user sees no feedback. The UI state may become inconsistent (e.g., `setToggling(false)` runs via finally but the source list is not refreshed).

### BC-4: `refresh()` silently swallows all load errors (LOW)

`LogSourcePanel.refresh()` at line 447 has `.catch(() => {})` which discards all errors. If `getLogSources`, `getLogSourcePlatforms`, or `getRepositories` fails, the user sees an empty state with no error indication.

**Impact:** If the backend is down or returns errors, the user sees "No log sources configured" which is misleading -- it should indicate a connection problem.

---

## Missing Configuration

### MC-1: `getLogSourcePlatforms` calls a route not in the build plan (INFORMATIONAL)

The plan's Contract 1 lists 6 endpoints (GET list, POST create, PUT update, DELETE, POST test, POST toggle). The frontend adds a 7th: `GET /api/log-sources/platforms` (api.ts line 280), and the backend implements it (routes.ts line 42). This is a reasonable addition to dynamically populate the platform dropdown, but it was not in the original plan. It works correctly -- `getRegisteredPlatforms()` return shape matches `LogSourcePlatform` interface exactly.

**Impact:** None -- this is a good addition. Noting for completeness.

### MC-2: No `repo_id` parameter in the `updateLogSource` API function (INFORMATIONAL)

The `updateLogSource` function in api.ts (line 306-326) does not accept `repo_id` in its params. The backend PUT route also does not allow changing `repo_id`. This is correct behavior -- a source should not be moved between repos after creation. Noting for completeness as the plan's request body spec shows `repo_id` in POST/PUT.

---

## Summary

**Phase 6 is SUBSTANTIALLY COMPLETE with two functional gaps.**

All 8 API functions are correctly implemented in `api.ts` with proper URL paths, HTTP methods, request bodies, and Content-Type headers matching the backend routes. The `LogSource` and `LogSourcePlatform` TypeScript interfaces match the backend response shapes exactly. Token security is handled correctly on both sides. The `LogSourcePanel` component renders properly in `SettingsView` with the correct import and mount pattern. All visible buttons are wired to real handlers that make real API calls. Loading states, form validation gates, and the empty state are all properly implemented.

**Two features are built in api.ts and the backend but not wired into the UI:**

1. **Edit/update source** (`updateLogSource`) -- API function and backend route exist but no UI invokes them. This is the most significant gap: users cannot modify a source after creation.
2. **Test saved source** (`testSavedLogSource`) -- API function and backend route exist but no UI button calls it. Users cannot re-test an existing source's connection.

**Three minor error-handling gaps exist:**
- Toggle and delete operations lack try/catch, so failures are silent.
- The initial data load swallows all errors, showing an empty state instead of an error message.

**Recommendation:** Before moving to the next phase, wire `updateLogSource` into the UI (add an edit mode to `SourceRow`) and add try/catch to `handleToggle` and `handleDelete`. The `testSavedLogSource` gap and load-error display are lower priority and can be deferred.
