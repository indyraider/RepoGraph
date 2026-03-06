# Phase 2 Audit: Sync Infrastructure

**Date:** 2026-03-06
**Auditor:** Claude Opus 4.6
**Status:** ISSUES FOUND -- see below

---

## Files Audited

- `/packages/backend/src/sync/manager.ts` (NEW)
- `/packages/backend/src/sync/watcher.ts` (NEW)
- `/packages/backend/src/sync/webhook.ts` (NEW)
- `/packages/backend/src/routes.ts` (MODIFIED)
- `/packages/backend/src/index.ts` (MODIFIED)

---

## Checklist Verification

### SyncManager class (manager.ts)

| Item | Status | Notes |
|------|--------|-------|
| Create SyncManager class with trigger(), updateMode(), getStatus(), getEvents() | PASS | All four methods present and exported via singleton `syncManager` |
| Implement per-repo concurrency (running/pending Map) | PASS | `repoStates = new Map<string, RepoSyncState>()` with `{ running, pending, latestTrigger }` |
| Implement coalescing (if digest running and new trigger arrives, set pending) | PASS | `trigger()` checks `state.running`, sets `state.pending = true` and saves `latestTrigger`. `finally` block re-fires if pending. |
| Implement logSyncEvent (INSERT into sync_events) | PASS | INSERT at line 86-96, UPDATE on success at line 113-122, UPDATE on failure at line 157-166 |
| Implement startup recovery (query repos with sync_mode=watcher, restart watchers) | PASS | Handled in watcher.ts `restartWatchers()`, called from `index.ts` startup |

### Webhook handler (webhook.ts)

| Item | Status | Notes |
|------|--------|-------|
| Create POST /api/webhooks/github route | PASS | Wired in routes.ts line 151 |
| Parse X-Hub-Signature-256 header | PASS | Line 70 reads the header |
| Look up repo by matching clone_url or ssh_url | ISSUE | See BUG-1 below |
| Validate HMAC-SHA256 signature using crypto.timingSafeEqual | PASS | `validateSignature()` uses `createHmac` + `timingSafeEqual` correctly |
| Filter: only handle push events | PASS | Lines 25-28 |
| Extract branch from payload.ref | PASS | Line 47 strips `refs/heads/` prefix |
| Compare payload.after against commit_sha -- skip if same | PASS | Lines 97-99 |
| Call syncManager.trigger() | PASS | Lines 103-108 |

### Watcher (watcher.ts)

| Item | Status | Notes |
|------|--------|-------|
| Create watcher.ts with startWatcher, stopWatcher, stopAllWatchers | PASS | All three exported |
| Configure chokidar: ignoreInitial, ignored patterns, usePolling: false | PASS | Lines 41-46 |
| Implement debounce on file events | PASS | Timer reset on each change, fires after `debounceMs` |
| Implement restartWatchers() for startup recovery | PASS | Queries repos with `sync_mode=watcher`, validates path, restarts |

### Routes & Integration (routes.ts, index.ts)

| Item | Status | Notes |
|------|--------|-------|
| Add PUT /api/repos/:id/sync route | PASS | Line 156, validates mode, validates local_path for watcher |
| Add GET /api/repos/:id/sync/status route | PASS | Line 219 |
| Add GET /api/repos/:id/sync/events route | PASS | Line 234 |
| Update DELETE /api/repositories/:id to stop watchers | PASS | Line 139 calls `stopWatcher(repoId)` |
| Add raw body capture middleware for webhook signature validation | PASS | index.ts lines 12-16, uses `express.json({ verify })` pattern |
| Add graceful shutdown for watchers | PASS | index.ts lines 94-100, SIGINT handler calls `stopAllWatchers()` then `closeNeo4j()` |

---

## Bugs Found

### BUG-1 (HIGH): Supabase `.or()` filter syntax is wrong in webhook.ts

**File:** `webhook.ts` line 54
**Code:** `.or(\`url.eq.${cloneUrl},url.eq.${sshUrl}\`)`
**Problem:** Supabase PostgREST `.or()` filter values are not URL-encoded or quoted. If `cloneUrl` is `https://github.com/user/repo.git`, the filter becomes `url.eq.https://github.com/user/repo.git,url.eq.git@github.com:user/repo.git`. The commas, colons, and slashes in URLs will break the PostgREST filter parser. The commas in particular will be interpreted as filter separators.
**Fix:** Use two separate queries, or properly escape the values. Safer approach:
```typescript
const { data: repos } = await sb
  .from("repositories")
  .select("id, url, branch, sync_mode, sync_config, commit_sha")
  .or(`url.eq."${cloneUrl}",url.eq."${sshUrl}"`);
```
Or better, query with `.in("url", [cloneUrl, sshUrl].filter(Boolean))`.

### BUG-2 (HIGH): `isRunningByUrl()` is a dead/broken method

**File:** `manager.ts` lines 45-54
**Code:** The method iterates over `repoStates` but the inner `if (state.running)` block contains only a comment and no logic. It always returns `false`.
**Impact:** Currently nothing calls this method, so no runtime breakage. But it is misleading dead code that should either be implemented or removed.

### BUG-3 (HIGH): `last_synced_sha` is never set correctly on first update

**File:** `manager.ts` lines 126-132
**Code:**
```typescript
await sb.from("repositories").update({
  last_synced_at: new Date().toISOString(),
  last_synced_sha: result.stats.changedFiles !== undefined ? undefined : undefined,
}).eq("id", opts.repoId);
```
**Problem:** The ternary expression `result.stats.changedFiles !== undefined ? undefined : undefined` always evaluates to `undefined`. This first update is completely wasted -- it sets `last_synced_sha` to `undefined` (which Supabase may interpret as NULL or ignore). Then lines 135-148 do a second read-then-write to fix this. This is two unnecessary DB round-trips that could be collapsed, and the first one sets `last_synced_sha` to null, creating a brief window where the value is wrong.
**Fix:** Remove lines 126-132 entirely. The read-back at lines 135-148 handles setting both `last_synced_at` and `last_synced_sha` correctly.

### BUG-4 (MEDIUM): `files_added` column is never populated in sync_events

**File:** `manager.ts` lines 113-122
**Problem:** The `sync_events` table schema (per the plan) includes a `files_added` column, but the sync event UPDATE on success only sets `files_changed`, `files_removed`, `duration_ms`, and `status`. The `files_added` column is never written. The `DigestResult.stats` interface does not expose a `files_added` count either.
**Impact:** The `files_added` column will always be NULL in sync_events.

### BUG-5 (MEDIUM): `activeDigests` Set in routes.ts is not integrated with SyncManager

**File:** `routes.ts` lines 15, 49, 54, 69
**Problem:** The plan says "Refactor `activeDigests` Set from routes.ts into SyncManager (single source of truth for concurrency)." This was NOT done. The `POST /digest` route still uses its own `activeDigests` Set keyed by URL, while SyncManager tracks concurrency separately keyed by repoId. If a webhook triggers a digest for the same repo that a manual digest is running for, neither system knows about the other.
**Impact:** Double digests can run concurrently for the same repo if triggered through different paths (manual POST /digest vs webhook/watcher via SyncManager).

### BUG-6 (MEDIUM): Webhook handler skips signature validation when no secret is configured

**File:** `webhook.ts` lines 73-88
**Problem:** If `webhookSecret` is falsy (empty string, null, undefined) AND `signature` is present, the code falls through to the branch/SHA checks and triggers a digest with no authentication at all. The conditional `if (webhookSecret && signature)` means: no secret configured = no validation required. This is by design for ease of setup, but it means any repo with `sync_mode: "webhook"` but no `webhook_secret` in `sync_config` is completely unauthenticated.
**Mitigation:** The `updateMode()` method in manager.ts always generates a `webhook_secret` when mode is "webhook" (line 200), so in normal flow this shouldn't happen. But if someone manually sets `sync_mode: "webhook"` in the database without a secret, the endpoint is open.

### BUG-7 (LOW): `simpleGit` is imported but never used in watcher.ts

**File:** `watcher.ts` line 2
**Problem:** `import { simpleGit } from "simple-git"` is present but never called. The plan says the watcher should read HEAD SHA via `simpleGit(localPath).log({ maxCount: 1 })` before triggering, but this was not implemented. The watcher triggers syncManager without a `commitSha` field.
**Impact:** The `SyncTrigger` interface does not even have a `commitSha` field, so the SHA from the local HEAD is never passed through. This means the SHA-dedup check that the webhook uses (compare `payload.after` against `commit_sha`) is not available for watcher triggers. This is arguably acceptable since the watcher debounce handles rapid-fire triggers, but it's a deviation from the plan.

---

## Execution Chain Verification

### Webhook flow

GitHub POST -> `routes.ts` `/webhooks/github` -> `handleGitHubWebhook` -> parses event type -> validates push -> extracts URLs -> looks up repo (BUG-1: filter syntax) -> checks sync_mode == webhook -> validates HMAC signature -> checks branch match -> checks SHA match -> `syncManager.trigger()` -> `executeDigest()` -> `runDigest()` -> logs sync event.

**Verdict:** Chain is complete but BUG-1 will cause repo lookup to fail for most URLs.

### Watcher flow

File change -> chokidar event -> `handleChange` -> debounce timer reset -> timer fires -> `syncManager.trigger({ repoId, url, branch, localPath, trigger: "watcher" })` -> `executeDigest()` -> `runDigest({ url, branch, localPath, trigger: "watcher" })` -> digest skips clone (localPath provided) -> logs sync event.

**Verdict:** Chain is complete. The `localPath` is correctly passed through to `runDigest` which uses it per Phase 1 changes.

### Sync API flow

`PUT /repos/:id/sync` -> validates mode -> looks up repo -> stops existing watcher -> if watcher: validates path, calls `updateMode()`, starts watcher -> response.

**Verdict:** Chain is complete and well-validated (checks directory exists, checks it's a directory).

### Startup flow

`start()` -> verifyConnections -> `restartWatchers()` -> queries repos with `sync_mode=watcher` -> for each: validates `local_path` exists -> `startWatcher()`.

**Verdict:** Chain is complete. Gracefully handles missing paths by logging a warning and skipping.

### Shutdown flow

SIGINT -> `stopAllWatchers()` -> iterates active watchers, clears timers, closes chokidar instances -> `closeNeo4j()` -> `process.exit(0)`.

**Verdict:** Chain is complete.

---

## Data Flow Verification

| Check | Result |
|-------|--------|
| Webhook correctly looks up repos by URL? | NO -- BUG-1: `.or()` filter syntax will break on URLs with commas/colons |
| Watcher correctly passes localPath to syncManager.trigger? | YES -- `entry.localPath` is passed in the SyncTrigger object |
| SyncManager correctly calls runDigest with DigestRequest shape? | YES -- `{ url, branch, localPath, trigger }` matches the DigestRequest interface |
| Raw body middleware captures buffer for HMAC validation? | YES -- `express.json({ verify })` callback stores `buf` as `req.rawBody` |

---

## Stubs and Placeholders

| Location | Issue |
|----------|-------|
| `manager.ts:45-54` `isRunningByUrl()` | Dead method -- has a loop with an empty conditional body, always returns false |
| `manager.ts:130` ternary expression | `changedFiles !== undefined ? undefined : undefined` is a placeholder that was never completed |
| `watcher.ts:2` `simpleGit` import | Imported but never used; HEAD SHA reading was planned but not implemented |

---

## Error Path Verification

| Scenario | Handling |
|----------|----------|
| Webhook receives invalid payload (no repository URLs) | Returns 400 with descriptive error message -- PASS |
| Webhook receives non-push event | Returns 200 with "ignored" status -- PASS |
| Webhook has invalid signature | Returns 401 -- PASS |
| Webhook for unknown repo URL | Returns 404 (assuming BUG-1 is fixed) -- PASS |
| Chokidar fails to start | Chokidar `error` event is handled with console.error (line 85-87). However, if `chokidar.watch()` itself throws synchronously, it will propagate to the caller (PUT /api/repos/:id/sync) which has a try/catch returning 500 -- ACCEPTABLE |
| syncManager.trigger fails | In watcher: the async error in the setTimeout callback is unhandled (no try/catch around `syncManager.trigger` in `handleChange`). If `trigger()` rejects, it becomes an unhandled promise rejection. -- ISSUE (see BUG-8 below) |
| Watcher's local_path doesn't exist on restart | `restartWatchers()` checks with `fs.access()` and skips with a warning -- PASS |
| Sync event INSERT fails | Caught with try/catch, logs warning, continues with digest -- PASS |
| Digest fails mid-run | Caught in `executeDigest`, sync event updated with "failed" status, state.running reset in finally -- PASS |

### BUG-8 (MEDIUM): Unhandled promise rejection in watcher debounce callback

**File:** `watcher.ts` lines 64-78
**Problem:** The `setTimeout` callback is `async` and calls `syncManager.trigger()`, but there is no try/catch. If `trigger()` (or `executeDigest()` within it) throws, the rejection is unhandled.
**Fix:** Wrap the body of the setTimeout callback in try/catch:
```typescript
entry.debounceTimer = setTimeout(async () => {
  entry.debounceTimer = null;
  try {
    // ... trigger logic
  } catch (err) {
    console.error(`[watcher] Failed to trigger digest for ${url}:`, err);
  }
}, entry.debounceMs);
```

---

## Summary of Issues by Severity

### HIGH (must fix before Phase 3)
1. **BUG-1:** Supabase `.or()` filter syntax will break on URLs containing commas/colons/slashes. Webhook repo lookup will fail.
2. **BUG-2:** `isRunningByUrl()` is a dead method with an empty body. Remove or implement.
3. **BUG-3:** First `last_synced_sha` update is a no-op ternary (`undefined : undefined`). Wasteful double DB write.

### MEDIUM (should fix before Phase 3)
4. **BUG-4:** `files_added` column never populated in sync_events.
5. **BUG-5:** `activeDigests` Set not refactored into SyncManager -- dual concurrency tracking allows double digests.
6. **BUG-6:** Repos with `sync_mode: "webhook"` but no `webhook_secret` skip signature validation entirely.
7. **BUG-8:** Unhandled promise rejection in watcher debounce callback.

### LOW (cleanup)
8. **BUG-7:** `simpleGit` imported but never used in watcher.ts. Dead import.

### Count: 3 HIGH, 4 MEDIUM, 1 LOW
