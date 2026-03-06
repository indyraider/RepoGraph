# Phase 3 Audit: New Views (Activity Log & Settings)

**Date:** 2026-03-06
**Status:** PASS — no blocking issues found

## Files Audited

| File | Lines | Verdict |
|------|-------|---------|
| `src/views/ActivityLogView.tsx` | 269 | PASS |
| `src/views/SettingsView.tsx` | 187 | PASS |
| `src/api.ts` | 180 | PASS — all called functions exist with matching signatures |
| `src/components/StatusBadge.tsx` | 16 | PASS |
| `src/components/McpPanel.tsx` | 71 | PASS |

---

## 1. EXECUTION CHAINS

### ActivityLogView
- **Repo selector** (`<select onChange>`): Calls `setSelectedRepoId(e.target.value)` on line 94. This triggers the `loadEvents` useCallback (dep: `[selectedRepoId]`) via the `useEffect` on line 55-57. Chain is complete.
- **Status filter buttons** (lines 110-137): Each calls `setFilterStatus(null)` (All button) or `setFilterStatus(filterStatus === status ? null : status)` (per-status toggle). `filteredEvents` is derived on lines 61-63 via `events.filter()`. Chain is complete — filters are toggle-able and the "All" button clears.
- **No refresh button**: There is no manual refresh/reload button for events. The `loadEvents` callback exists and could be wired to one, but the plan does not require it. Not a defect.

### SettingsView
- **Health refresh button** (line 63-69): Calls `refreshHealth()` which sets loading/error states, calls `checkHealth()`, and handles success/failure. Button is disabled during loading. Chain is complete.
- **McpPanel copy button** (McpPanel.tsx line 28-31): `handleCopy` calls `navigator.clipboard.writeText(mcpConfig)`, toggles `copied` state, resets after 2500ms. Chain is complete.

**Verdict: PASS** — every interactive element has a real handler with complete execution chain.

---

## 2. DATA FLOW

### Import Resolution
| Import | Source | Export Type | Usage | Match |
|--------|--------|-------------|-------|-------|
| `getRepositories` | `api.ts:96` | named export | ActivityLogView line 3 | PASS |
| `getSyncEvents` | `api.ts:132` | named export | ActivityLogView line 4 | PASS |
| `Repository` (type) | `api.ts:15` | named export interface | ActivityLogView line 5 | PASS |
| `SyncEvent` (type) | `api.ts:62` | named export interface | ActivityLogView line 6 | PASS |
| `checkHealth` | `api.ts:76` | named export | SettingsView line 2 | PASS |
| `HealthStatus` (type) | `api.ts:46` | named export interface | SettingsView line 2 | PASS |
| `StatusBadge` | `StatusBadge.tsx:3` | named export | SettingsView line 14 | PASS |
| `McpPanel` | `McpPanel.tsx:4` | named export | SettingsView line 15 | PASS |

### API Function Signatures vs Usage
- `getRepositories()` — api.ts returns `Promise<Repository[]>`. ActivityLogView calls with no args, expects array. **MATCH.**
- `getSyncEvents(repoId: string)` — api.ts takes `string`, returns `Promise<SyncEvent[]>`. ActivityLogView passes `selectedRepoId` (guaranteed non-null by the `if (!selectedRepoId) return` guard on line 41). **MATCH.**
- `checkHealth()` — api.ts returns `Promise<HealthStatus>`. SettingsView calls `.then(setHealth)` where `health` is `HealthStatus | null`. **MATCH.**

### Type Shape Verification
- **`SyncEvent` fields used in ActivityLogView**: `id`, `status`, `trigger`, `files_changed`, `files_added`, `files_removed`, `duration_ms`, `started_at`, `error_log`. All present in `api.ts` SyncEvent interface (lines 62-74). **MATCH.**
- **`HealthStatus` fields used in SettingsView**: `neo4j`, `supabase`. Both present in `api.ts` HealthStatus interface (lines 46-50). **MATCH.**
- **`StatusBadge` props**: `{ connected: boolean; label: string }`. SettingsView passes `connected={health.neo4j === "connected"}` (boolean) and `label={health.neo4j}` (string). **MATCH.**
- **`McpPanel` props**: Takes no props. SettingsView renders `<McpPanel />` with no props. **MATCH.**
- **`Repository` fields used in ActivityLogView**: `id`, `name`, `branch`. All present in `api.ts` Repository interface. `id` is `string`, matching `selectedRepoId: string | null`. **MATCH.**

### Route Wiring
- `main.tsx` line 10-11: Both views are lazy-loaded via `lazy(() => import(...))`.
- Both files use `export default function` — compatible with `lazy()` dynamic imports. **MATCH.**

**Verdict: PASS** — all imports resolve, all signatures match, all type shapes align.

---

## 3. SCROLL CONTRACT

- **ActivityLogView line 74**: `<div className="h-full overflow-y-auto">` — **PASS**
- **SettingsView line 42**: `<div className="h-full overflow-y-auto">` — **PASS**

---

## 4. STUBS

- **TODO/FIXME/HACK/XXX**: Grep across all `src/**/*.{ts,tsx}` found zero matches. No stub markers in any Phase 3 file.
- **Placeholder returns**: No functions return placeholder/hardcoded data. All data comes from real API calls.
- The only "placeholder" hits in the codebase are HTML `placeholder` attributes on input fields in DashboardView (not Phase 3 scope).

**Verdict: PASS** — no stubs or placeholders.

---

## 5. ERROR PATHS

### ActivityLogView
| State | Condition | Rendered | Line |
|-------|-----------|----------|------|
| Loading | `loading === true` | Spinner + "Loading events..." | 146-151 |
| Error | `error && !loading` | AlertTriangle + error message | 154-159 |
| Empty (no repos) | `!loading && !error && repos.length === 0` | Inbox icon + "No repositories digested yet" | 162-170 |
| Empty (no events) | `!loading && !error && repos.length > 0 && filteredEvents.length === 0` | Activity icon + contextual message (filter-aware) | 173-185 |
| Data | `!loading && !error && filteredEvents.length > 0` | Event cards | 188-265 |

- Repo fetch error: caught on line 35, sets `error` string, `loading` set to false via `finally`.
- Event fetch error: caught on line 48, sets `error`, clears `events`, `loading` set to false via `finally`.

### SettingsView
| State | Condition | Rendered | Line |
|-------|-----------|----------|------|
| Loading | `loading === true` | Spinner + "Checking connections..." | 73-78 |
| Error (unreachable) | `!loading && error` | WifiOff icon + "Backend unreachable" | 80-86 |
| Healthy | `!loading && health` | Neo4j + Supabase status rows with StatusBadge | 88-120 |

- Health check error: caught on line 27-29, sets `health` to null and `error` to true, `loading` set to false via `finally`.

**Verdict: PASS** — all five states (loading, error, empty-no-repos, empty-no-events, data) handled in ActivityLogView. All three states (loading, error, healthy) handled in SettingsView.

---

## 6. NAMED vs DEFAULT EXPORTS

| Component | Export Style | Import Style | Correct |
|-----------|-------------|--------------|---------|
| `ActivityLogView` | `export default function` | `lazy(() => import(...))` in main.tsx | PASS |
| `SettingsView` | `export default function` | `lazy(() => import(...))` in main.tsx | PASS |
| `StatusBadge` | `export function` (named) | `{ StatusBadge }` in SettingsView | PASS |
| `McpPanel` | `export function` (named) | `{ McpPanel }` in SettingsView | PASS |

**Verdict: PASS** — views use default exports for lazy loading, shared components use named exports with destructured imports.

---

## Minor Observations (Non-blocking)

1. **No HTTP status check in `getRepositories` or `getSyncEvents`**: Both API functions (api.ts lines 96-98, 132-134) call `res.json()` without checking `res.ok`. If the backend returns a non-200 status with a JSON error body, it will be silently treated as valid data. Compare with `getGraphData` (line 159) and `startDigest` (line 88), which do check `res.ok`. This is a pre-existing pattern in api.ts, not introduced by Phase 3, but worth noting for a future hardening pass.

2. **`loadEvents` called on initial mount with null repo**: When `selectedRepoId` is initially `null`, `loadEvents` fires (via useEffect) but returns early on line 41. Meanwhile the repo-fetch useEffect also sets `loading(false)` on completion — and `loadEvents` sets `loading(true)` then immediately returns without setting it back. However, this is a race that resolves correctly: the repo-fetch sets `selectedRepoId` which re-triggers `loadEvents` with a valid ID, resetting loading properly. No user-visible bug, but worth awareness.

---

## Summary

Phase 3 is clean. All execution chains terminate in real handlers. All imports resolve with correct export syntax. Type shapes match between API layer and view consumption. Both views honor the scroll contract. No stubs or TODOs. Loading, error, and empty states are handled comprehensively in both views.

**Ready for Phase 4: Polish & Cleanup.**
