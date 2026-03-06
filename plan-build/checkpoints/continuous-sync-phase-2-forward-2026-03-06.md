# Forward Planning Checkpoint: Phase 2 -> Phase 3

**Date:** 2026-03-06
**Phase Completed:** Phase 2 (Sync Infrastructure)
**Next Phase:** Phase 3 (API + Frontend)

---

## 1. Interface Extraction: What Phase 2 Actually Built

### Exported Types (manager.ts)

```ts
export interface SyncTrigger {
  repoId: string;
  url: string;
  branch: string;
  localPath?: string;
  trigger: "webhook" | "watcher" | "manual";
}

export interface SyncTriggerResult {
  status: "started" | "queued" | "skipped" | "error";
  message?: string;
  syncEventId?: string;
}
```

### Exported Functions & Methods

**syncManager (singleton, manager.ts):**
- `syncManager.isRunning(repoId: string): boolean`
- `syncManager.isRunningByUrl(url: string): boolean` (NOTE: stub, always returns false)
- `syncManager.trigger(opts: SyncTrigger): Promise<SyncTriggerResult>`
- `syncManager.updateMode(repoId, mode, config): Promise<{ webhookUrl?: string; webhookSecret?: string }>`
- `syncManager.getStatus(repoId): Promise<{ sync_mode, sync_config, last_synced_at, last_synced_sha, is_running, is_pending }>`
- `syncManager.getEvents(repoId, limit?): Promise<unknown[]>`

**watcher.ts exports:**
- `startWatcher(repoId, url, branch, localPath, debounceMs?): void`
- `stopWatcher(repoId): void`
- `stopAllWatchers(): void`
- `isWatching(repoId): boolean`
- `restartWatchers(): Promise<void>`

**webhook.ts exports:**
- `handleGitHubWebhook(req, res): Promise<void>`

### API Routes (routes.ts) -- ALL routes already exist

| Method | Path | Request Body | Response Shape |
|--------|------|-------------|----------------|
| POST | `/api/webhooks/github` | GitHub push payload | `SyncTriggerResult` or `{ status, reason }` or `{ error }` |
| PUT | `/api/repos/:id/sync` | `{ mode: "off"\|"webhook"\|"watcher", config?: { local_path?, debounce_ms?, webhook_secret? } }` | See below |
| GET | `/api/repos/:id/sync/status` | - | `{ sync_mode, sync_config, last_synced_at, last_synced_sha, is_running, is_pending, watcher_active }` |
| GET | `/api/repos/:id/sync/events` | - | Array of sync_event rows |

**PUT /api/repos/:id/sync response shapes by mode:**
- `mode: "watcher"` -> `{ status: "watching", webhookUrl?: undefined, webhookSecret?: undefined }`
- `mode: "webhook"` -> `{ status: "webhook_enabled", webhookUrl: "/api/webhooks/github", webhookSecret: "<hex>" }`
- `mode: "off"` -> `{ status: "sync_disabled" }`

---

## 2. Mismatch Detection: Plan vs. Reality

### FINDING: Sync API routes were built in Phase 2, not Phase 3

The plan assigns "Sync API Routes" to Phase 3, but they are **already implemented in routes.ts** (lines 156-243). This means Phase 3's scope for the backend is reduced -- it only needs frontend work.

### FINDING: Route path inconsistency between existing and sync routes

Existing routes use `/api/repositories/:id` (full word "repositories"). Sync routes use `/api/repos/:id/sync`. The plan uses both interchangeably. This is a cosmetic inconsistency but won't cause bugs -- they are different endpoints for different purposes. The frontend must use:
- `/api/repositories/:id` for CRUD operations
- `/api/repos/:id/sync` for sync operations

### FINDING: `activeDigests` Set not refactored into SyncManager

The plan says: "Refactor `activeDigests` Set from `routes.ts` into SyncManager (single source of truth for concurrency)." This was **NOT done**. The `activeDigests` Set still exists at line 15 of routes.ts and is used independently of the SyncManager for the POST `/api/digest` route. The SyncManager has its own parallel concurrency tracking in `repoStates`. This means:
- Manual digests via POST `/api/digest` use the old `activeDigests` Set (keyed by URL)
- Sync-triggered digests use SyncManager's `repoStates` Map (keyed by repoId)
- A sync trigger and a manual digest for the same repo can run simultaneously

**Impact on Phase 3:** Low for now, but this is a latent concurrency bug. Phase 3 frontend could trigger a manual re-digest while a watcher digest is running.

### FINDING: `SyncTriggerResult.status` includes "started" but plan says "running"

The plan (Contract 2) says Sync Manager returns `"queued" | "running" | "skipped"`. The actual implementation returns `"started" | "queued" | "skipped" | "error"`. The webhook endpoint (Contract 1) was supposed to return the same set but returns `SyncTriggerResult` directly. Frontend must use the actual values: `"started"`, `"queued"`, `"skipped"`, `"error"`.

### FINDING: `isRunningByUrl` is a dead stub

`SyncManager.isRunningByUrl()` (lines 45-54) has an empty loop body and always returns `false`. It is not called anywhere. This appears to be an incomplete attempt at providing backward compatibility with the URL-keyed `activeDigests` set.

### FINDING: `updateMode` returns relative webhook URL

`syncManager.updateMode()` returns `webhookUrl: "/api/webhooks/github"` (relative path). The plan says the frontend should "display the webhook URL and secret for the user to copy into GitHub settings." A relative URL is not useful for GitHub configuration -- the frontend will need to construct the full URL (e.g., `http://localhost:3001/api/webhooks/github` or whatever the user's tunnel URL is). This is a **frontend concern** -- the frontend should prepend the backend's base URL or let the user provide a public URL.

### FINDING: `last_synced_sha` update has a bug

In manager.ts lines 126-149, the first `.update()` call sets `last_synced_sha: undefined` (line 130 -- the ternary evaluates to `undefined` in both branches), then immediately does a second query to read `commit_sha` and update again. The first update is wasteful and sends `undefined` which Supabase may interpret as "don't update" or may set to null depending on the client version. The logic works but is fragile.

---

## 3. Hook Points for Phase 3: Frontend Integration Guide

### 3A. Changes needed in `api.ts`

**Add to Repository interface:**
```ts
export interface Repository {
  // ... existing fields ...
  sync_mode?: string;         // "off" | "webhook" | "watcher"
  sync_config?: Record<string, unknown>;
  last_synced_at?: string | null;
  last_synced_sha?: string | null;
}
```

**Add new interfaces:**
```ts
export interface SyncStatus {
  sync_mode: string;
  sync_config: Record<string, unknown>;
  last_synced_at: string | null;
  last_synced_sha: string | null;
  is_running: boolean;
  is_pending: boolean;
  watcher_active: boolean;
}

export interface SyncEvent {
  id: string;
  repo_id: string;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  files_changed: number | null;
  files_added: number | null;
  files_removed: number | null;
  duration_ms: number | null;
  status: string;
  error_log: string | null;
}

export interface UpdateSyncModeResponse {
  status: string;
  webhookUrl?: string;
  webhookSecret?: string;
}
```

**Add new API functions:**
```ts
export async function updateSyncMode(
  id: string,
  mode: "off" | "webhook" | "watcher",
  config?: Record<string, unknown>
): Promise<UpdateSyncModeResponse> {
  const res = await fetch(`${API_BASE}/repos/${id}/sync`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, config }),
  });
  return res.json();
}

export async function getSyncStatus(id: string): Promise<SyncStatus> {
  const res = await fetch(`${API_BASE}/repos/${id}/sync/status`);
  return res.json();
}

export async function getSyncEvents(id: string): Promise<SyncEvent[]> {
  const res = await fetch(`${API_BASE}/repos/${id}/sync/events`);
  return res.json();
}
```

### 3B. Changes needed in `App.tsx`

The plan calls for these UI features:

1. **Sync mode toggle on repo row** -- Off / Webhook / Watcher buttons or dropdown
   - Calls `PUT /api/repos/:id/sync` with `{ mode, config }`
   - Mode "off" needs no config
   - Mode "webhook" needs no config (secret is auto-generated)
   - Mode "watcher" needs `{ local_path: string, debounce_ms?: number }`

2. **Webhook URL + secret display** -- shown when mode is "webhook"
   - Comes from the `PUT` response: `{ webhookUrl, webhookSecret }`
   - Frontend should prepend a base URL for display (the API returns relative path `/api/webhooks/github`)

3. **Local path input** -- shown when mode is "watcher"
   - Text input for the filesystem path, validated server-side

4. **Sync status indicator** -- per repo row
   - GET `/api/repos/:id/sync/status` returns `sync_mode`, `is_running`, `is_pending`, `watcher_active`
   - Color-code: "watching" (green), "webhook" (blue), "off" (gray), running (yellow)

5. **Last synced timestamp** -- shown alongside existing `last_digest_at`
   - Available from `repositories` data (already returned by GET `/api/repositories` if columns exist)
   - Also available from sync status endpoint

6. **Sync events log** -- expandable section per repo
   - GET `/api/repos/:id/sync/events` returns array of events
   - Show: timestamp, trigger type, files changed, duration, status, error

7. **Auto-refresh** -- poll sync status every 10s when sync mode is active
   - Use `setInterval` in a `useEffect` that depends on the repo's sync mode

### 3C. Endpoint -> Frontend Feature Mapping

| Frontend Feature | Endpoint | Method |
|-----------------|----------|--------|
| Sync mode toggle | `PUT /api/repos/:id/sync` | Write |
| Webhook credentials display | Response from PUT above | Read (from PUT response) |
| Watcher path input | `PUT /api/repos/:id/sync` with config | Write |
| Sync status badge | `GET /api/repos/:id/sync/status` | Read (poll) |
| Sync events list | `GET /api/repos/:id/sync/events` | Read |
| Last synced time | `GET /api/repositories` (repo row data) | Read (existing) |

---

## 4. Summary of Issues to Address

### Must fix before/during Phase 3:
1. **Dual concurrency tracking** -- `activeDigests` Set and SyncManager's `repoStates` operate independently. A manual digest via POST `/api/digest` and a sync-triggered digest can run in parallel for the same repo. Consider having POST `/api/digest` go through `syncManager.trigger()` with `trigger: "manual"`.

### Should fix but non-blocking:
2. **`isRunningByUrl` is dead code** -- remove it or implement it properly.
3. **`last_synced_sha` double-update** -- simplify the update logic in `executeDigest`.
4. **Relative webhook URL** -- frontend needs to construct full URL for display.

### Cosmetic:
5. **Route path inconsistency** (`/api/repositories/:id` vs `/api/repos/:id/sync`) -- works fine, just inconsistent naming.

---

## 5. Phase 3 Scope (Adjusted)

Since the Sync API routes are already built, Phase 3 reduces to:

1. **Frontend only:** Add types, API functions, and UI components to `api.ts` and `App.tsx`
2. **Optional backend fix:** Refactor POST `/api/digest` to use SyncManager for concurrency (resolves dual-tracking issue)
3. **Integration testing**
