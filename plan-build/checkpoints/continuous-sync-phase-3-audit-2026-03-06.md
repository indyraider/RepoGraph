# Phase 3 Final Integration Audit
**Date:** 2026-03-06
**Status:** ISSUES FOUND

---

## End-to-End Flow Verification

### Flow 1: Webhook Flow
```
GitHub POST /api/webhooks/github
  -> index.ts: express.json({ verify }) captures rawBody on req  ........... OK
  -> routes.ts: router.post("/webhooks/github", handleGitHubWebhook)  ..... OK
  -> webhook.ts: filters non-push events with 200  ........................ OK
  -> webhook.ts: extracts clone_url / ssh_url from body  .................. OK
  -> webhook.ts: queries Supabase repos by .in("url", candidateUrls)  ..... OK
  -> webhook.ts: checks repo.sync_mode === "webhook"  ..................... OK
  -> webhook.ts: reads rawBody from (req as any).rawBody  ................. OK
  -> webhook.ts: validateSignature() uses HMAC-SHA256 + timingSafeEqual  .. OK
  -> webhook.ts: checks branch match (repo.branch !== branch)  ............ OK
  -> webhook.ts: checks commit SHA unchanged  ............................. OK
  -> webhook.ts: calls syncManager.trigger({ repoId, url, branch,
       trigger: "webhook" })  ............................................. OK
  -> manager.ts: checks concurrency, coalesces if running  ................ OK
  -> manager.ts: creates sync_events row with status "running"  ........... OK
  -> manager.ts: calls runDigest({ url, branch, trigger: "webhook" })  .... OK
  -> digest.ts: no localPath => clones repo  .............................. OK
  -> digest.ts: incremental diff via getStoredHashes + diffFiles  ......... OK
  -> digest.ts: loads to Neo4j (incremental or full purge)  ............... OK
  -> digest.ts: loads to Supabase (changed files only if incremental)  .... OK
  -> manager.ts: updates sync_events with success, files_changed, etc.  ... OK
  -> manager.ts: updates repositories.last_synced_at + last_synced_sha  ... OK
  -> frontend: GET /api/repositories returns last_synced_at  .............. OK
     (routes.ts: .select("*") includes new sync columns)
```
**Status: PASS**

### Flow 2: Watcher Flow
```
File change detected by chokidar
  -> watcher.ts: chokidar fires "add"/"change"/"unlink"  ................. OK
  -> watcher.ts: handleChange() resets debounce timer  .................... OK
  -> watcher.ts: debounce fires after debounceMs  ......................... OK
  -> watcher.ts: creates SyncTrigger with localPath + trigger:"watcher"  .. OK
  -> watcher.ts: calls syncManager.trigger()  ............................. OK
  -> manager.ts: concurrency check + coalesce  ............................ OK
  -> manager.ts: calls runDigest({ url, branch, localPath, trigger:
       "watcher" })  ..................................................... OK
  -> digest.ts: isLocalPath=true => skips clone  .......................... OK
  -> digest.ts: reads HEAD SHA from local .git via simple-git  ............ OK
  -> digest.ts: skips "same commit" check for watcher (isLocalPath)  ...... OK
  -> digest.ts: scans localPath directly  ................................. OK
  -> digest.ts: incremental Neo4j update for changed files  ............... OK
  -> digest.ts: skips cleanupClone (finally block checks isLocalPath)  .... OK
  -> manager.ts: logs sync event, updates last_synced_at  ................. OK
  -> frontend: shows updated last_synced_at  .............................. OK
```
**Status: PASS**

### Flow 3: UI Enable Webhook
```
User clicks "Webhook" button in SyncPanel
  -> App.tsx: handleModeChange("webhook") called  ......................... OK
  -> api.ts: updateSyncMode(repo.id, "webhook", {})  ..................... OK
  -> api.ts: PUT /api/repos/${repoId}/sync  ............................... OK
  -> routes.ts: PUT /api/repos/:id/sync handler receives it  .............. OK
     (frontend uses /api/repos/:id/sync, backend route is /repos/:id/sync
      mounted under /api prefix => matches)  .............................. OK
  -> routes.ts: validates mode is "webhook"  .............................. OK
  -> routes.ts: fetches repo from Supabase  ............................... OK
  -> routes.ts: calls stopWatcher(repoId) preemptively  ................... OK
  -> routes.ts: calls syncManager.updateMode(repoId, "webhook", config)  .. OK
  -> manager.ts: generates webhook secret via randomBytes(32).hex  ........ OK
  -> manager.ts: stores sync_mode + sync_config in Supabase  .............. OK
  -> manager.ts: returns { webhookUrl, webhookSecret }  ................... OK
  -> routes.ts: responds with { status: "webhook_enabled", webhookUrl,
       webhookSecret }  ................................................... OK
  -> App.tsx: reads result.webhookSecret, constructs full URL with
       window.location.origin  ............................................ OK
  -> App.tsx: displays URL + truncated secret with copy buttons  ........... OK
```
**Status: PASS** (with note -- see Issue #1 below)

### Flow 4: UI Enable Watcher
```
User clicks "Watcher" button, has entered local path
  -> App.tsx: handleModeChange("watcher") called  ......................... OK
  -> App.tsx: validates localPath is non-empty client-side  ................ OK
  -> api.ts: updateSyncMode(repo.id, "watcher", { local_path, debounce_ms })  OK
  -> api.ts: PUT /api/repos/${repoId}/sync  ............................... OK
  -> routes.ts: validates mode === "watcher"  ............................. OK
  -> routes.ts: validates local_path exists and is directory via fs.stat  .. OK
  -> routes.ts: calls syncManager.updateMode(repoId, "watcher", config)  .. OK
  -> manager.ts: stores sync_mode + sync_config in Supabase  .............. OK
  -> routes.ts: calls startWatcher(repoId, repo.url, repo.branch,
       localPath, debounceMs)  ............................................ OK
  -> watcher.ts: creates chokidar watcher with IGNORE_PATTERNS  ........... OK
  -> watcher.ts: stores in activeWatchers Map  ............................ OK
  -> routes.ts: responds { status: "watching" }  .......................... OK
  -> App.tsx: sets mode to "watcher", calls onRefresh  .................... OK
```
**Status: PASS**

### Flow 5: Startup Recovery
```
Backend starts
  -> index.ts: start() called  ............................................ OK
  -> index.ts: verifies Neo4j + Supabase connections  ..................... OK
  -> index.ts: if sbOk, calls restartWatchers()  .......................... OK
  -> watcher.ts restartWatchers(): queries repos with sync_mode="watcher"   OK
  -> watcher.ts: reads sync_config.local_path for each repo  .............. OK
  -> watcher.ts: validates path exists via fs/promises access()  ........... OK
  -> watcher.ts: calls startWatcher(id, url, branch, localPath, debounce)   OK
  -> watcher.ts: logs count of restarted watchers  ........................ OK
```
**Status: PASS**

### Flow 6: Graceful Shutdown
```
SIGINT received
  -> index.ts: process.on("SIGINT") handler fires  ....................... OK
  -> index.ts: clears timeoutInterval  ................................... OK
  -> index.ts: calls stopAllWatchers()  .................................. OK
  -> watcher.ts: iterates activeWatchers, closes each chokidar instance  . OK
  -> watcher.ts: clears debounce timers  ................................. OK
  -> index.ts: calls closeNeo4j()  ....................................... OK
  -> index.ts: process.exit(0)  .......................................... OK
```
**Status: PASS**

---

## Data Shape Verification

### Frontend `Repository` Interface vs Supabase Schema

| Field | Frontend `api.ts` | Supabase `repositories` table | Match? |
|-------|------------------|-------------------------------|--------|
| id | `string` | `UUID PK` | OK |
| url | `string` | `TEXT` | OK |
| name | `string` | `TEXT` | OK |
| branch | `string` | `TEXT` | OK |
| commit_sha | `string \| null` | `TEXT` | OK |
| last_digest_at | `string \| null` | `TIMESTAMPTZ` | OK |
| status | `string` | `TEXT` | OK |
| created_at | `string` | `TIMESTAMPTZ` | OK |
| sync_mode | `string` | `TEXT NOT NULL DEFAULT 'off'` | OK |
| sync_config | `Record<string, unknown>` | `JSONB DEFAULT '{}'` | OK |
| last_synced_at | `string \| null` | `TIMESTAMPTZ` | OK |
| last_synced_sha | `string \| null` | `TEXT` | OK |

**GET /api/repositories** uses `.select("*")` which returns all columns including the new sync columns. The frontend `Repository` interface includes all four new fields. **MATCH.**

### Frontend `SyncEvent` Interface vs `sync_events` Table

| Field | Frontend `api.ts` | Supabase `sync_events` table | Match? |
|-------|------------------|------------------------------|--------|
| id | `string` | `UUID PK` | OK |
| repo_id | `string` | `UUID FK` | OK |
| trigger | `string` | `TEXT NOT NULL` | OK |
| started_at | `string` | `TIMESTAMPTZ DEFAULT now()` | OK |
| completed_at | `string \| null` | `TIMESTAMPTZ` | OK |
| files_changed | `number` | `INTEGER DEFAULT 0` | OK |
| files_added | `number` | `INTEGER DEFAULT 0` | OK |
| files_removed | `number` | `INTEGER DEFAULT 0` | OK |
| duration_ms | `number \| null` | `INTEGER` | OK |
| status | `string` | `TEXT NOT NULL DEFAULT 'running'` | OK |
| error_log | `string \| null` | `TEXT` | OK |

**MATCH.**

### Frontend `SyncStatus` Interface vs Backend `getStatus()` + Route Response

| Field | Frontend `api.ts` | Backend `routes.ts` response | Match? |
|-------|------------------|------------------------------|--------|
| sync_mode | `string` | from `syncManager.getStatus()` | OK |
| sync_config | `Record<string, unknown>` | from `syncManager.getStatus()` | OK |
| last_synced_at | `string \| null` | from `syncManager.getStatus()` | OK |
| last_synced_sha | `string \| null` | from `syncManager.getStatus()` | OK |
| is_running | `boolean` | from `syncManager.getStatus()` | OK |
| is_pending | `boolean` | from `syncManager.getStatus()` | OK |
| watcher_active | `boolean` | added by route via `isWatching()` | OK |

**MATCH.**

### API Route Paths: Frontend vs Backend

| Frontend (`api.ts`) | Backend (`routes.ts`) | Match? |
|---------------------|-----------------------|--------|
| `PUT /api/repos/${repoId}/sync` | `router.put("/repos/:id/sync")` mounted under `/api` | OK |
| `GET /api/repos/${repoId}/sync/status` | `router.get("/repos/:id/sync/status")` mounted under `/api` | OK |
| `GET /api/repos/${repoId}/sync/events` | `router.get("/repos/:id/sync/events")` mounted under `/api` | OK |
| `GET /api/repositories` | `router.get("/repositories")` mounted under `/api` | OK |
| `DELETE /api/repositories/${id}` | `router.delete("/repositories/:id")` mounted under `/api` | OK |
| `POST /api/digest` | `router.post("/digest")` mounted under `/api` | OK |

Note: The sync routes use `/repos/:id/sync` while the CRUD routes use `/repositories/:id`. This is an intentional design -- the sync routes are a separate API surface from the REST resource routes. The paths match between frontend and backend. **No mismatch.**

---

## Issues Found

### Issue #1: `files_added` Never Populated in Sync Events (Minor)

**Location:** `manager.ts` lines 104-111

The `sync_events` table has a `files_added` column (INTEGER DEFAULT 0), and the frontend `SyncEvent` interface includes `files_added`. However, the Sync Manager never writes `files_added` when updating a sync event on success:

```typescript
.update({
  completed_at: new Date().toISOString(),
  files_changed: result.stats.changedFiles ?? result.stats.fileCount,
  files_removed: result.stats.deletedFiles ?? 0,
  duration_ms: result.stats.durationMs,
  status: "success",
})
```

The `files_added` field is omitted. It will always remain at its default value of `0`. The `DigestResult.stats` does not track `files_added` separately from `files_changed` -- the `diffFiles()` function in `digest.ts` lumps new files (no stored hash) and modified files (different hash) together into the `changed` array.

**Impact:** Low. The column exists and the frontend can display it, but it will always be 0. Users will see `files_changed` but never `files_added`.

**Fix:** Either (a) split `diffFiles()` to distinguish new vs modified files and track `filesAdded` in `DigestResult.stats`, then populate it in the sync event update, or (b) remove `files_added` from the schema and frontend interface if it is not needed for v1.

### Issue #2: `webhookUrl` Returned by Manager is Relative, Frontend Constructs Absolute (Cosmetic)

**Location:** `manager.ts` line 181, `App.tsx` lines 33 and 75

The `syncManager.updateMode()` returns `webhookUrl: "/api/webhooks/github"` (relative). The frontend ignores this returned value and instead constructs its own URL using `window.location.origin + "/api/webhooks/github"`. The route response from `routes.ts` spreads the manager result (`...result`), so the response includes `webhookUrl: "/api/webhooks/github"`.

**Impact:** None functionally. The frontend does the right thing by constructing the full URL with the origin. However, the relative URL in the API response could confuse API consumers.

**Fix:** Either have the backend construct the full URL (requires knowing the host), or document that the frontend is responsible for constructing the absolute URL.

### Issue #3: `activeDigests` Set in `routes.ts` Is Redundant with SyncManager (Technical Debt)

**Location:** `routes.ts` lines 15-16, 49-53, 69

The `POST /digest` route still uses its own `activeDigests` Set for double-submit prevention, completely separate from the SyncManager's per-repo concurrency. This means manual digests via the `/digest` endpoint bypass the SyncManager entirely -- they call `runDigest()` directly without creating a sync event or updating `last_synced_at`.

**Impact:** Medium. Manual digests do not go through SyncManager, so:
- No sync event is logged for manual digests triggered via the UI "Digest" / "Re-Digest" buttons.
- The SyncManager's concurrency tracking does not know about manual digests. A webhook-triggered digest could run concurrently with a manual digest for the same repo.
- `last_synced_at` and `last_synced_sha` are not updated for manual digests (only `last_digest_at` and `commit_sha` are updated by `runDigest()` itself).

The build plan's wiring checklist item says "Refactor `activeDigests` Set from `routes.ts` into SyncManager (single source of truth for concurrency)." This refactoring was not completed.

**Fix:** Modify the `POST /digest` route to use `syncManager.trigger({ ..., trigger: "manual" })` instead of calling `runDigest()` directly, and remove the `activeDigests` Set.

### Issue #4: No Webhook Signature Validation When Secret Exists But No Signature Header Is Present -- Already Handled (Confirmed OK)

**Location:** `webhook.ts` lines 86-89

The code correctly returns 401 when a webhook secret is configured but no signature header is provided. This prevents unauthenticated requests from triggering digests on repos with secrets. **Not an issue.**

### Issue #5: Watcher Does Not Read Current HEAD SHA Before Triggering (Minor)

**Location:** `watcher.ts` lines 67-76

The watcher's debounce handler creates a `SyncTrigger` without a `commitSha` field. The `SyncTrigger` interface does not include `commitSha`. The SHA is instead read inside `digest.ts` when `isLocalPath` is true (lines 148-156). This is fine -- the SHA is obtained at digest time, which is the correct approach since the user may commit between the file change and the debounce firing.

**Not an issue** -- the design is correct.

---

## Summary

The end-to-end wiring across all three phases is **solid**. All six flows trace correctly from trigger to storage to display. The data shapes between frontend interfaces, backend responses, and Supabase schema are aligned. API route paths match between frontend and backend.

**Critical issues:** None.

**Medium issues:**
1. **Issue #3:** The `POST /digest` route bypasses SyncManager entirely, creating a concurrency blind spot and missing sync event logging for manual digests. This was called out in the build plan as a planned refactor that was not completed.

**Minor issues:**
1. **Issue #1:** `files_added` column is never populated -- always 0.
2. **Issue #2:** `webhookUrl` in API response is relative (cosmetic only).

**Verdict:** The continuous sync feature is functionally complete and correctly wired. The manual digest route should be migrated to use SyncManager to close the concurrency gap (Issue #3), but this is not a blocker for the sync feature itself since webhook and watcher flows both work correctly through the SyncManager.
