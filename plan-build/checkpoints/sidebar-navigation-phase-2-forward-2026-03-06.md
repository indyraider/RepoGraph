# Forward Planning Checkpoint: Phase 2 -> Phase 3

**Date:** 2026-03-06
**Phase Completed:** Phase 2 (Extract & Migrate DashboardView)
**Next Phase:** Phase 3 (Activity Log & Settings views)
**Remaining:** Phase 3, Phase 4 (Final cleanup)

---

## 1. Interface Extraction: What Phase 2 Actually Built

### CopyButton

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/components/CopyButton.tsx
Export: export function CopyButton (NAMED export, not default)
```

**Props:**
```ts
{ text: string }
```

**Behavior:** Copies `text` to clipboard on click, shows green check icon for 2 seconds, then reverts to copy icon. Self-contained -- uses only `useState` from React and `Copy`, `Check` from lucide-react.

### StatusBadge

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/components/StatusBadge.tsx
Export: export function StatusBadge (NAMED export, not default)
```

**Props:**
```ts
{ connected: boolean; label: string }
```

**Behavior:** Renders an inline badge. When `connected` is `true`: green background/text with CheckCircle2 icon. When `false`: red background/text with XCircle icon. Uses `CheckCircle2`, `XCircle` from lucide-react.

### McpPanel

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/components/McpPanel.tsx
Export: export function McpPanel (NAMED export, not default)
```

**Props:** None.

**Behavior:** Renders a self-contained MCP config panel with a hardcoded JSON config string and a copy-to-clipboard button. Uses `useState` from React and `Network`, `Copy`, `Check` from lucide-react. Has its own internal `copied` state and `handleCopy` function (does NOT use CopyButton -- has its own copy logic).

### DashboardView

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/views/DashboardView.tsx
Export: export default function DashboardView (DEFAULT export)
```

**Props:** None (self-contained).

**Internal components:** Contains a local `SyncPanel` function component (not exported).

**SyncPanel props:** `{ repo: Repository; onRefresh: () => void }`

**Imports from api.ts:** `checkHealth`, `startDigest`, `getRepositories`, `deleteRepository`, `updateSyncMode`, `getSyncEvents`, `Repository`, `HealthStatus`, `SyncEvent`

**Imports from shared components:** `CopyButton` (named import from `../components/CopyButton`), `StatusBadge` (named import from `../components/StatusBadge`), `McpPanel` (named import from `../components/McpPanel`)

**Key detail:** Uses `h-full overflow-y-auto` as root div (correctly fills AppShell's `<main>` container, not `h-screen`).

### GraphExplorer

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/GraphExplorer.tsx
Export: export default function GraphExplorer (DEFAULT export)
```

**Props:** None. (The `onBack` prop has been removed.)

**Phase 2 changes verified:**
1. `onBack` prop removed -- signature is now `export default function GraphExplorer()` (line 108)
2. Back button removed -- top bar now has only "Graph Explorer" title on left and controls on right
3. `ArrowLeft` import removed from lucide imports
4. Root div changed from `h-screen` to `h-full` (line 470)
5. Top accent line removed -- AppShell provides it

**Imports from api.ts:** `getGraphData`, `getFileContent`, `getRepositories`, `GraphNode`, `GraphEdge`, `Repository`

### api.ts (Complete Function & Type Inventory)

```
File: /Users/mattjones/Documents/RepoGraph/packages/frontend/src/api.ts
```

**Exported Types:**

| Type | Key Fields |
|------|-----------|
| `Repository` | `id`, `url`, `name`, `branch`, `commit_sha`, `last_digest_at`, `status`, `created_at`, `sync_mode`, `sync_config`, `last_synced_at`, `last_synced_sha` |
| `DigestJob` | `id`, `repo_id`, `status`, `stage`, `started_at`, `completed_at`, `error_log`, `stats` |
| `HealthStatus` | `status`, `neo4j`, `supabase` |
| `SyncStatus` | `sync_mode`, `sync_config`, `last_synced_at`, `last_synced_sha`, `is_running`, `is_pending`, `watcher_active` |
| `SyncEvent` | `id`, `repo_id`, `trigger`, `started_at`, `completed_at`, `files_changed`, `files_added`, `files_removed`, `duration_ms`, `status`, `error_log` |
| `GraphNode` | `id`, `label`, `props` |
| `GraphEdge` | `source`, `target`, `type`, `props` |
| `GraphData` | `nodes: GraphNode[]`, `edges: GraphEdge[]` |

**Exported Functions:**

| Function | Signature | Returns |
|----------|-----------|---------|
| `checkHealth()` | No params | `Promise<HealthStatus>` |
| `startDigest(url, branch)` | `(string, string)` | `Promise<any>` (data with optional `.error`, `.stats`) |
| `getRepositories()` | No params | `Promise<Repository[]>` |
| `getJob(jobId)` | `(string)` | `Promise<DigestJob>` |
| `deleteRepository(id)` | `(string)` | `Promise<any>` |
| `updateSyncMode(repoId, mode, config?)` | `(string, string, Record<string, unknown>)` | `Promise<any>` |
| `getSyncStatus(repoId)` | `(string)` | `Promise<SyncStatus>` |
| `getSyncEvents(repoId)` | `(string)` | `Promise<SyncEvent[]>` |
| `getGraphData(repoId)` | `(string)` | `Promise<GraphData>` |
| `getFileContent(repoId, filePath)` | `(string, string)` | `Promise<{ content: string; language: string }>` |

---

## 2. Mismatch Detection: Plan vs. Phase 2 Reality for Phase 3

### CHECK 1: ActivityLogView needs `getRepositories()` and `getSyncEvents(repoId)` -- PASS

Both exist in `api.ts` with the correct signatures:
- `getRepositories()` -> `Promise<Repository[]>` (line 96)
- `getSyncEvents(repoId: string)` -> `Promise<SyncEvent[]>` (line 132)

The `Repository` type has `.id` and `.name` for a dropdown selector. The `SyncEvent` type has all the fields needed for an event list: `id`, `trigger`, `started_at`, `completed_at`, `files_changed`, `files_added`, `files_removed`, `duration_ms`, `status`, `error_log`.

**No mismatch.**

### CHECK 2: SettingsView needs `checkHealth()`, `StatusBadge`, `McpPanel` -- PASS with notes

- `checkHealth()` exists, returns `Promise<HealthStatus>` with `{ status, neo4j, supabase }` -- correct for displaying connection status.
- `StatusBadge` exists as a named export from `../components/StatusBadge`. Props: `{ connected: boolean; label: string }`.
- `McpPanel` exists as a named export from `../components/McpPanel`. Props: none.

**IMPORTANT:** All three shared components (CopyButton, StatusBadge, McpPanel) use **named exports**, not default exports. Phase 3 must import them with curly braces:
```ts
import { StatusBadge } from "../components/StatusBadge";
import { McpPanel } from "../components/McpPanel";
```

**No mismatch**, but import syntax must match.

### CHECK 3: Missing API functions for Phase 3 -- NONE

The plan specifies:
- ActivityLogView: `getRepositories()` + `getSyncEvents(repoId)` -- both present
- SettingsView: `checkHealth()` -- present

There is also `getSyncStatus(repoId)` available if SettingsView wants to show per-repo sync status, though the plan does not call for it.

### CHECK 4: CSS classes used by shared components -- PASS

DashboardView uses `card-glass`, `input-focus-ring`, and `animate-pulse-soft`. All three are defined in `index.css` (lines 47-73). Phase 3 views can safely use these same CSS classes.

### CHECK 5: Placeholder files have correct export signatures -- PASS

- `ActivityLogView.tsx`: `export default function ActivityLogView()` -- correct default export, no props
- `SettingsView.tsx`: `export default function SettingsView()` -- correct default export, no props

Both match what `main.tsx` expects via `lazy(() => import("./views/ActivityLogView"))` and `lazy(() => import("./views/SettingsView"))`.

### CHECK 6: Scrolling contract -- IMPORTANT

AppShell's `<main>` has `overflow-hidden`. Each view must manage its own scrolling. DashboardView does this correctly with `h-full overflow-y-auto` on its root div. Phase 3 views must follow the same pattern:
```tsx
<div className="h-full overflow-y-auto">
  {/* view content */}
</div>
```

---

## 3. Dependency Readiness: What Phase 3 Views Need to Import

### ActivityLogView will need:

| Import | From | Export Type |
|--------|------|-------------|
| `getRepositories` | `../api` | Named |
| `getSyncEvents` | `../api` | Named |
| `Repository` (type) | `../api` | Named |
| `SyncEvent` (type) | `../api` | Named |

**lucide-react icons likely needed:** `Activity`, `Clock`, `CircleDot`, `Inbox`, `Loader2`, `AlertTriangle`, `ChevronDown` (for repo selector)

### SettingsView will need:

| Import | From | Export Type |
|--------|------|-------------|
| `checkHealth` | `../api` | Named |
| `HealthStatus` (type) | `../api` | Named |
| `StatusBadge` | `../components/StatusBadge` | Named |
| `McpPanel` | `../components/McpPanel` | Named |

**lucide-react icons likely needed:** `Settings`, `Wifi`, `WifiOff`, `Loader2`, `Server`, `KeyRound`

**Optional (not in plan but available):** `getSyncStatus` from api.ts if SettingsView wants to show sync status.

---

## 4. Phase 4 Scope Assessment

### Already done (from Phase 1):

| Item | Status | Where |
|------|--------|-------|
| Sidebar CSS transitions | DONE | `Sidebar.tsx` line 40: `transition-[width] duration-200 ease-in-out` |
| Sidebar localStorage persistence | DONE | `Sidebar.tsx` lines 19-36: `STORAGE_KEY = "repograph-sidebar-collapsed"` |
| Collapsed width 60px / Expanded width 220px | DONE | `Sidebar.tsx` line 41 |
| NavLink active highlighting | DONE | `Sidebar.tsx` lines 64-69 |

### Remaining for Phase 4:

1. **Dead code removal** -- Verify `App.tsx` and `App.css` have been deleted (Phase 2 should have done this; needs confirmation)
2. **Final styling pass** -- Visual consistency across all views
3. **Route testing** -- All routes work, catch-all redirects to `/dashboard`
4. **Edge cases** -- Verify GraphExplorer layout with sidebar (60px rail + 208px type filter + graph canvas + detail panel)

### Phase 4 is significantly reduced. The main infrastructure work (transitions, localStorage) was completed in Phase 1.

---

## 5. Summary for Phase 3 Builder

### Phase 3 must do:

1. **Replace** `src/views/ActivityLogView.tsx` placeholder with:
   - Repo selector dropdown (using `getRepositories()`)
   - Auto-select first repo on mount
   - Sync events table/list (using `getSyncEvents(selectedRepoId)`)
   - Loading, empty, and error states
   - Root div: `<div className="h-full overflow-y-auto">`
   - Default export: `export default function ActivityLogView()`

2. **Replace** `src/views/SettingsView.tsx` placeholder with:
   - Health status display (using `checkHealth()`)
   - StatusBadge for Neo4j and Supabase connection status
   - McpPanel for MCP config copy
   - Current API URL and key status (masked) from env vars
   - Loading and error states
   - Root div: `<div className="h-full overflow-y-auto">`
   - Default export: `export default function SettingsView()`

### Phase 3 must NOT do:
- Touch router config (already correct)
- Touch Sidebar (already correct)
- Touch DashboardView or GraphExplorer (complete)
- Create new shared components (all needed ones exist)

### Risks:
- **NONE:** All API functions exist with correct signatures. All shared components exist with correct exports. Placeholder files have correct default exports. No router changes needed.
- **LOW:** SettingsView plan says "Display current API URL and key status (masked)" -- these are `import.meta.env.VITE_API_URL` and `import.meta.env.VITE_API_KEY`, available directly in any component. No API call needed.

### Exact file paths for Phase 3 modifications:
- `/Users/mattjones/Documents/RepoGraph/packages/frontend/src/views/ActivityLogView.tsx` (replace placeholder)
- `/Users/mattjones/Documents/RepoGraph/packages/frontend/src/views/SettingsView.tsx` (replace placeholder)
