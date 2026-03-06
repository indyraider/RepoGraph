# Build Plan: Continuous Sync

**Created:** 2026-03-06
**Brainstorm:** `../brainstorm/continuous-sync-brainstorm-2026-03-06.md`
**Status:** Draft

## Overview

Add automatic re-digestion to RepoGraph via two trigger modes: GitHub webhooks (push events) and local file watching (chokidar). Both modes feed into a shared Sync Manager that enforces one-digest-at-a-time concurrency per repo, coalesces rapid triggers, and logs sync events. The digest pipeline is refactored to support skipping the clone step (for local paths) and truly incremental Neo4j updates (update only changed files' graph nodes instead of purge-and-reload).

---

## Component Inventory

| # | Component | Inputs | Outputs | Key Dependencies |
|---|-----------|--------|---------|-----------------|
| 1 | Supabase Schema Additions | SQL DDL | New columns + table | Hosted Supabase |
| 2 | Digest Pipeline Refactor | DigestRequest (now with optional localPath, trigger type) | Same as before, but incremental Neo4j | Existing pipeline, `removeFilesFromNeo4j` |
| 3 | Sync Manager | Trigger events (webhook/watcher/manual) | Calls `runDigest`, logs sync events | digest.ts, Supabase |
| 4 | GitHub Webhook Endpoint | GitHub POST payload + signature header | Trigger to Sync Manager | crypto (HMAC), Sync Manager |
| 5 | Local File Watcher | Filesystem events | Trigger to Sync Manager | chokidar, simple-git (for SHA) |
| 6 | Sync API Routes | HTTP requests from frontend | Sync Manager commands, Supabase reads | Express, Sync Manager |
| 7 | Frontend Sync UI | API responses | HTTP requests to sync routes | React, existing App.tsx |

---

## Integration Contracts

### Contract 1: GitHub → Webhook Endpoint

```
[GitHub] → [Webhook Endpoint]
  What flows:     POST /api/webhooks/github
                  Headers: X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
                  Body: { ref: "refs/heads/main", after: "<sha>",
                         repository: { clone_url, ssh_url, full_name },
                         commits: [...] }
  How it flows:   HTTP POST from GitHub's webhook delivery system
  Auth/Config:    HMAC-SHA256 signature using per-repo webhook_secret stored in
                  repositories.sync_config.webhook_secret
  Error path:     Invalid signature → 401. Unknown repo URL → 404.
                  Non-push event → 200 (ignore). Digest already running → 200 (queued/coalesced).
```

### Contract 2: Webhook Endpoint → Sync Manager

```
[Webhook Endpoint] → [Sync Manager]
  What flows:     syncManager.trigger({ repoId, url, branch, commitSha, trigger: "webhook" })
  How it flows:   Internal function call
  Auth/Config:    None (already validated webhook signature)
  Error path:     Sync Manager returns status: "queued" | "running" | "skipped" (same SHA)
```

### Contract 3: File Watcher → Sync Manager

```
[File Watcher] → [Sync Manager]
  What flows:     syncManager.trigger({ repoId, url, branch, localPath, trigger: "watcher" })
  How it flows:   Internal function call after debounce window closes
  Auth/Config:    None
  Error path:     Digest already running → coalesce (queue one more run after current completes).
                  Watcher error → log to console + update sync status to "error".
```

### Contract 4: Sync Manager → Digest Pipeline

```
[Sync Manager] → [Digest Pipeline]
  What flows:     runDigest({ url, branch, localPath?, trigger? })
  How it flows:   Internal function call (existing runDigest, extended with optional params)
  Auth/Config:    None
  Error path:     Digest failure → Sync Manager logs sync event with status "failed" + error.
                  Sync Manager updates repo status back to "idle" (not "error" — don't block manual digests).
```

### Contract 5: Sync Manager → Supabase (sync events)

```
[Sync Manager] → [Supabase]
  What flows:     INSERT into sync_events: { repo_id, trigger, started_at, completed_at,
                  files_changed, files_added, files_removed, duration_ms, status, error_log }
  How it flows:   @supabase/supabase-js client
  Auth/Config:    Same SUPABASE_URL + SUPABASE_SERVICE_KEY as existing
  Error path:     Insert failure → log to console (non-blocking, don't fail the digest)
```

### Contract 6: Sync API Routes → Sync Manager

```
[Sync API Routes] → [Sync Manager]
  What flows:     PUT /api/repos/:id/sync → syncManager.updateMode(repoId, mode, config)
                  GET /api/repos/:id/sync/status → syncManager.getStatus(repoId)
  How it flows:   Express route handlers calling Sync Manager methods
  Auth/Config:    None (local tool)
  Error path:     Invalid mode → 400. Repo not found → 404.
                  Watcher start failure → 500 with error message.
```

### Contract 7: Sync API Routes → Supabase (sync events)

```
[Sync API Routes] → [Supabase]
  What flows:     GET /api/repos/:id/sync/events → SELECT from sync_events
  How it flows:   @supabase/supabase-js client
  Auth/Config:    Same credentials
  Error path:     Query failure → 500
```

### Contract 8: Frontend → Sync API Routes

```
[Frontend] → [Sync API Routes]
  What flows:     PUT /api/repos/:id/sync { mode: "off"|"webhook"|"watcher", config: {...} }
                  GET /api/repos/:id/sync/status
                  GET /api/repos/:id/sync/events
  How it flows:   fetch() from React
  Auth/Config:    None
  Error path:     API error → display inline error in repo row
```

---

## End-to-End Flows

### Flow 1: GitHub Webhook Triggers Incremental Digest

```
1.  Developer pushes commit to GitHub
2.  GitHub sends POST /api/webhooks/github with push event payload
3.  Webhook handler extracts X-Hub-Signature-256 header
4.  Handler looks up repo by matching clone_url or ssh_url against repositories.url
5.  Handler retrieves webhook_secret from repositories.sync_config
6.  Handler validates HMAC-SHA256 signature using webhook_secret
7.  Handler extracts branch from ref ("refs/heads/main" → "main")
8.  Handler extracts commit SHA from payload.after
9.  Handler compares SHA against repositories.commit_sha — if same, return 200 (no changes)
10. Handler calls syncManager.trigger({ repoId, url, branch, commitSha, trigger: "webhook" })
11. Sync Manager checks if a digest is already running for this repo
12. If running: mark "pending" flag (coalesce) → return { status: "queued" }
13. If not running: proceed
14. Sync Manager calls runDigest({ url, branch, trigger: "webhook" })
15. runDigest clones repo (normal clone path for webhook — we don't have local files)
16. runDigest scans, parses, resolves, loads (incremental: only changed files to Supabase)
17. runDigest performs incremental Neo4j update (delete changed file nodes, re-insert)
18. Sync Manager logs sync_event: { trigger: "webhook", files_changed: N, status: "success" }
19. Sync Manager updates repositories.last_synced_at and last_synced_sha
20. If "pending" flag was set during digest: re-trigger with latest SHA
21. Frontend polls /api/repos/:id/sync/status — sees updated last_synced_at
```

### Flow 2: Local File Watcher Triggers Incremental Digest

```
1.  Developer saves a file in their local repo at ~/projects/myrepo/src/foo.ts
2.  Chokidar detects file change event
3.  Watcher resets debounce timer (default 30s)
4.  No more changes for 30 seconds — debounce fires
5.  Watcher reads current HEAD SHA from local .git via simple-git
6.  Watcher calls syncManager.trigger({ repoId, url, branch, localPath: "~/projects/myrepo", commitSha, trigger: "watcher" })
7.  Sync Manager checks concurrency — if running, coalesce
8.  Sync Manager calls runDigest({ url, branch, localPath: "~/projects/myrepo", trigger: "watcher" })
9.  runDigest detects localPath is provided — SKIPS clone step
10. runDigest scans localPath directly (same scanner, different root)
11. runDigest diffs content hashes against stored hashes
12. runDigest parses ALL files (import resolution needs full set)
13. runDigest performs incremental Neo4j update for changed files only
14. runDigest uploads only changed files to Supabase
15. runDigest does NOT call cleanupClone (localPath is user's working directory)
16. Sync Manager logs sync_event
17. Sync Manager updates last_synced_at, last_synced_sha
18. If pending flag set: re-trigger
```

### Flow 3: User Enables Webhook Sync Mode

```
1.  User clicks sync mode toggle on repo row → selects "Webhook"
2.  Frontend sends PUT /api/repos/:id/sync { mode: "webhook" }
3.  Backend generates a random webhook_secret (crypto.randomUUID or randomBytes)
4.  Backend updates repositories: { sync_mode: "webhook", sync_config: { webhook_secret } }
5.  Backend returns { webhookUrl: "http://localhost:3001/api/webhooks/github", webhookSecret: "<secret>" }
6.  Frontend displays the webhook URL and secret for the user to copy into GitHub settings
7.  User goes to GitHub repo → Settings → Webhooks → Add webhook
8.  User pastes URL and secret, selects "push" events
```

### Flow 4: User Enables Local Watcher Mode

```
1.  User clicks sync mode toggle on repo row → selects "Watcher"
2.  Frontend shows path input field
3.  User enters "/Users/dev/projects/myrepo"
4.  Frontend sends PUT /api/repos/:id/sync { mode: "watcher", config: { local_path: "/Users/dev/projects/myrepo", debounce_ms: 30000 } }
5.  Backend validates path exists and is a directory
6.  Backend updates repositories: { sync_mode: "watcher", sync_config: { local_path, debounce_ms } }
7.  Backend calls syncManager.startWatcher(repoId, localPath, debouncMs)
8.  Sync Manager creates chokidar watcher on the path
9.  Backend returns { status: "watching" }
10. Frontend shows "Watching" status indicator
```

### Flow 5: Sync Error Path

```
1.  Watcher or webhook triggers digest
2.  Digest fails (e.g., parse error, Neo4j down)
3.  Sync Manager catches error
4.  Sync Manager logs sync_event with status: "failed", error_log: error.message
5.  Sync Manager does NOT change repo status to "error" (preserves last good state)
6.  Sync Manager does NOT stop the watcher or disable webhooks
7.  Next trigger will retry naturally
8.  Frontend shows last sync event with error in sync log
```

---

## Issues Found

### Dead Ends

1. **`removeFilesFromNeo4j` exists but is never called.** The function at `loader.ts:400-418` deletes file nodes and their CONTAINS children for specific paths, but `digest.ts` never uses it — it always calls `purgeRepoFromNeo4j` (full purge). This function is the key to incremental Neo4j updates but needs to also clean up IMPORTS edges pointing TO the deleted files, and EXPORTS edges FROM those files.

2. **No cleanup of IMPORTS edges pointing to changed files.** When file B is deleted or modified, `removeFilesFromNeo4j` deletes B's nodes and B's outgoing CONTAINS edges. But if file A has an IMPORTS edge pointing to file B, that edge remains dangling. The Cypher in `removeFilesFromNeo4j` uses `OPTIONAL MATCH (f)-[:CONTAINS]->(sym) DETACH DELETE sym, f` — the `DETACH DELETE` on `f` WILL delete incoming IMPORTS edges to `f`, so this is actually handled. Confirmed: DETACH DELETE removes all relationships connected to the deleted nodes.

### Missing Sources

3. **`chokidar` not installed.** The backend `package.json` does not include `chokidar`. Must be added: `npm install chokidar -w packages/backend`.

4. **No `sync_mode`, `sync_config`, `last_synced_at`, `last_synced_sha` columns on `repositories` table.** Must be added via SQL ALTER TABLE.

5. **No `sync_events` table.** Must be created.

6. **`local_path` not stored anywhere.** The `repositories` table has `url` but no field for a local filesystem path. Must be stored in `sync_config.local_path`.

### Phantom Dependencies

7. **Webhook signature validation assumes `crypto.timingSafeEqual`.** Node.js built-in `crypto` provides this, so no new dependency needed. But the comparison must use `timingSafeEqual` (not `===`) to prevent timing attacks.

### One-Way Streets

8. **Watcher has no persistence across server restarts.** If the backend restarts, all active watchers are lost. On startup, the backend must query Supabase for repos with `sync_mode: "watcher"` and restart their watchers.

9. **No way to pause a watcher without changing mode.** Consider: should "pausing" be a separate state, or is toggling to "off" and back sufficient? Keep it simple — off/on is enough for v1.

### Permission Gaps

10. **Webhook endpoint is publicly accessible.** Without signature validation, anyone can trigger digests. The HMAC-SHA256 validation is essential. But even with it, the endpoint is reachable by anyone who can reach the host. Since RepoGraph is local-first, this is acceptable — document that the webhook endpoint should not be exposed to the public internet without a tunnel and signature validation.

---

## Wiring Checklist

### Infrastructure & Schema

- [ ] Add columns to `repositories` table: `sync_mode TEXT DEFAULT 'off'`, `sync_config JSONB DEFAULT '{}'`, `last_synced_at TIMESTAMPTZ`, `last_synced_sha TEXT`
- [ ] Create `sync_events` table: id (uuid pk), repo_id (uuid fk), trigger (text), started_at (timestamptz), completed_at (timestamptz), files_changed (int), files_added (int), files_removed (int), duration_ms (int), status (text), error_log (text)
- [ ] Disable RLS on `sync_events` (or use service role key — same as other tables)
- [ ] Install chokidar: `npm install chokidar -w packages/backend`

### Digest Pipeline Refactor (Phase 1)

- [ ] Extend `DigestRequest` interface: add optional `localPath?: string` and `trigger?: "manual" | "webhook" | "watcher"`
- [ ] Modify `runDigest()`: if `localPath` is provided, skip `cloneRepo()` and use `localPath` directly
- [ ] Modify `runDigest()`: if `localPath` is provided, get commit SHA from local `.git` via `simple-git(localPath).log()`
- [ ] Modify `runDigest()`: skip `cleanupClone()` when `localPath` is provided (don't delete user's working directory)
- [ ] Implement truly incremental Neo4j update: instead of `purgeRepoFromNeo4j` + full reload, call `removeFilesFromNeo4j` for changed+deleted files, then re-insert only changed files' nodes/edges
- [ ] Handle import edge consistency: after removing changed files from Neo4j, re-insert ALL import edges (import resolution is global — a changed export in one file affects import edges from other files)
- [ ] Add large-diff fallback: if >500 files changed, fall back to full purge+reload (current behavior)

### Sync Manager (Phase 2)

- [ ] Create `packages/backend/src/sync/manager.ts` with SyncManager class
- [ ] Implement `trigger(opts: SyncTrigger): Promise<SyncTriggerResult>` — accepts trigger from any source, enforces concurrency
- [ ] Implement per-repo concurrency: Map<repoId, { running: boolean, pending: boolean }>
- [ ] Implement coalescing: if digest running and new trigger arrives, set `pending = true`; when current digest completes, if pending, re-trigger with latest state
- [ ] Implement `logSyncEvent(event)`: INSERT into sync_events table
- [ ] Implement `updateMode(repoId, mode, config)`: update repositories table, start/stop watchers
- [ ] Implement `getStatus(repoId)`: return current sync mode, watcher status, last synced info
- [ ] Refactor `activeDigests` Set from `routes.ts` into SyncManager (single source of truth for concurrency)
- [ ] Implement startup recovery: on backend start, query repos with `sync_mode: "watcher"`, restart watchers

### GitHub Webhook Endpoint (Phase 2)

- [ ] Create `POST /api/webhooks/github` route
- [ ] Parse `X-Hub-Signature-256` header
- [ ] Look up repo by matching `payload.repository.clone_url` or `payload.repository.ssh_url` against `repositories.url`
- [ ] Retrieve `webhook_secret` from `repositories.sync_config`
- [ ] Validate HMAC-SHA256 signature using `crypto.createHmac('sha256', secret)` + `crypto.timingSafeEqual`
- [ ] Filter: only handle `X-GitHub-Event: push` events, ignore others with 200
- [ ] Extract branch from `payload.ref` (strip `refs/heads/` prefix)
- [ ] Compare `payload.after` against `repositories.commit_sha` — skip if same
- [ ] Call `syncManager.trigger({ repoId, url, branch, commitSha, trigger: "webhook" })`
- [ ] Return 200 with `{ status: "queued" | "running" | "skipped" }`

### Local File Watcher (Phase 2)

- [ ] Create `packages/backend/src/sync/watcher.ts`
- [ ] Implement `startWatcher(repoId, localPath, debouncMs)`: create chokidar instance watching `localPath`
- [ ] Configure chokidar: `ignoreInitial: true`, `ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**']`, `usePolling: false`
- [ ] Implement debounce: on any file event, reset a timer; when timer fires, trigger sync
- [ ] On debounce fire: read HEAD SHA via `simpleGit(localPath).log({ maxCount: 1 })`
- [ ] Call `syncManager.trigger({ repoId, url, branch, localPath, trigger: "watcher" })`
- [ ] Implement `stopWatcher(repoId)`: close chokidar instance, remove from active watchers map
- [ ] Store active watchers in a Map<repoId, FSWatcher> for lifecycle management
- [ ] Handle watcher errors: log to console, update sync status

### Sync API Routes (Phase 3)

- [ ] Add `PUT /api/repos/:id/sync` route: validate mode (off/webhook/watcher), validate config, call syncManager.updateMode()
- [ ] When mode = "webhook": generate webhook_secret via `crypto.randomBytes(32).toString('hex')`, store in sync_config, return webhook URL + secret
- [ ] When mode = "watcher": validate local_path exists (fs.access), store in sync_config, start watcher
- [ ] When mode = "off": stop watcher if running, clear sync_config
- [ ] Add `GET /api/repos/:id/sync/status` route: return sync_mode, watcher status (watching/stopped/error), last_synced_at, last_synced_sha
- [ ] Add `GET /api/repos/:id/sync/events` route: SELECT from sync_events WHERE repo_id = :id ORDER BY started_at DESC LIMIT 20
- [ ] Update existing `DELETE /api/repositories/:id` to stop any active watcher before purging

### Frontend Sync UI (Phase 3)

- [ ] Add `sync_mode`, `last_synced_at`, `last_synced_sha` to Repository interface in `api.ts`
- [ ] Add API functions: `updateSyncMode(id, mode, config)`, `getSyncStatus(id)`, `getSyncEvents(id)`
- [ ] Add sync mode toggle to repo row (Off / Webhook / Watcher buttons or dropdown)
- [ ] When Webhook selected: display webhook URL and secret (with copy button)
- [ ] When Watcher selected: show local path input, debounce config (optional), start button
- [ ] Show sync status indicator: "Watching" (green) / "Webhook" (blue) / "Off" (gray) / "Error" (red)
- [ ] Show `last_synced_at` timestamp in repo row (alongside existing `last_digest_at`)
- [ ] Add expandable sync log section: list recent sync_events with timestamp, trigger, files changed, duration, status
- [ ] Auto-refresh sync status every 10s when a sync mode is active (poll GET /api/repos/:id/sync/status)

---

## Build Order

### Phase 1 — Pipeline Refactor (Foundation)

Build order:
1. Supabase schema additions (sync columns + sync_events table)
2. Digest pipeline refactor (localPath support, incremental Neo4j updates)
3. Test: manual digest still works, incremental updates produce correct graph

**Checkpoint after Phase 1.**

### Phase 2 — Sync Infrastructure

Build order:
1. Sync Manager (concurrency, coalescing, lifecycle)
2. GitHub Webhook Endpoint
3. Local File Watcher (chokidar)
4. Refactor routes.ts to use Sync Manager for concurrency
5. Backend startup recovery (restart watchers for repos with sync_mode: "watcher")
6. Test: webhook triggers digest, watcher triggers digest, concurrency works

**Checkpoint after Phase 2.**

### Phase 3 — API + Frontend

Build order:
1. Sync API routes
2. Frontend sync UI components
3. Integration test: enable webhook mode via UI, push to GitHub, verify graph updates
4. Integration test: enable watcher mode via UI, save file locally, verify graph updates

**Checkpoint after Phase 3.**
