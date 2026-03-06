# Phase 1 Forward Plan Review
**Phase completed:** Pipeline Refactor (Foundation)
**Date:** 2026-03-06
**Plan updates needed:** YES

---

## Actual Interfaces Built

### DigestRequest (digest.ts:9-16)
```typescript
export interface DigestRequest {
  url: string;
  branch: string;
  localPath?: string;
  trigger?: "manual" | "webhook" | "watcher";
}
```

### DigestResult (digest.ts:18-34)
```typescript
export interface DigestResult {
  repoId: string;
  jobId: string;
  incremental: boolean;
  stats: {
    fileCount: number;
    symbolCount: number;
    importCount: number;
    packageCount: number;
    exportedSymbolCount: number;
    nodeCount: number;
    edgeCount: number;
    durationMs: number;
    changedFiles?: number;
    deletedFiles?: number;
  };
}
```

### Exported Functions — digest.ts
| Function | Signature | Return Type |
|----------|-----------|-------------|
| `runDigest` | `(req: DigestRequest) => Promise<DigestResult>` | `Promise<DigestResult>` |

### Exported Functions — loader.ts (new in Phase 1)
| Function | Signature | Return Type |
|----------|-----------|-------------|
| `purgeImportEdges` | `(repoUrl: string) => Promise<void>` | `Promise<void>` |
| `removeFilesFromNeo4j` | `(repoUrl: string, filePaths: string[]) => Promise<void>` | `Promise<void>` |
| `removeFilesFromSupabase` | `(repoId: string, filePaths: string[]) => Promise<void>` | `Promise<void>` |

### Exported Functions — loader.ts (pre-existing, unchanged)
| Function | Signature | Return Type |
|----------|-----------|-------------|
| `loadToNeo4j` | `(repoUrl: string, repoName: string, branch: string, commitSha: string, files: ScannedFile[]) => Promise<{ nodeCount: number; edgeCount: number }>` | `Promise<{nodeCount, edgeCount}>` |
| `loadSymbolsToNeo4j` | `(repoUrl: string, symbols: ParsedSymbol[], exportsList: ParsedExport[]) => Promise<{ nodeCount: number; edgeCount: number }>` | `Promise<{nodeCount, edgeCount}>` |
| `loadImportsToNeo4j` | `(repoUrl: string, resolvedImports: ResolvedImport[]) => Promise<number>` | `Promise<number>` |
| `loadDependenciesToNeo4j` | `(repoUrl: string, packages: IndexedPackage[]) => Promise<{ nodeCount: number; edgeCount: number }>` | `Promise<{nodeCount, edgeCount}>` |
| `loadToSupabase` | `(repoId: string, files: ScannedFile[]) => Promise<void>` | `Promise<void>` |
| `purgeRepoFromNeo4j` | `(repoUrl: string) => Promise<void>` | `Promise<void>` |
| `purgeRepoFromSupabase` | `(repoId: string) => Promise<void>` | `Promise<void>` |

### Supabase Schema — New Columns on `repositories`
| Column | Type | Default | Nullable |
|--------|------|---------|----------|
| `sync_mode` | `TEXT` | `'off'` | NOT NULL |
| `sync_config` | `JSONB` | `'{}'` | nullable |
| `last_synced_at` | `TIMESTAMPTZ` | none | nullable |
| `last_synced_sha` | `TEXT` | none | nullable |

### Supabase Schema — New Table `sync_events`
| Column | Type | Default | Nullable |
|--------|------|---------|----------|
| `id` | `UUID` (PK) | `gen_random_uuid()` | NOT NULL |
| `repo_id` | `UUID` (FK -> repositories.id, ON DELETE CASCADE) | none | NOT NULL |
| `trigger` | `TEXT` | none | NOT NULL |
| `started_at` | `TIMESTAMPTZ` | `now()` | nullable |
| `completed_at` | `TIMESTAMPTZ` | none | nullable |
| `files_changed` | `INTEGER` | `0` | nullable |
| `files_added` | `INTEGER` | `0` | nullable |
| `files_removed` | `INTEGER` | `0` | nullable |
| `duration_ms` | `INTEGER` | none | nullable |
| `status` | `TEXT` | `'running'` | NOT NULL |
| `error_log` | `TEXT` | none | nullable |

Indexes: `idx_sync_events_repo (repo_id)`, `idx_sync_events_started (started_at DESC)`.
RLS disabled on `sync_events`.

### New Dependency in package.json
- `chokidar: ^5.0.0` (added)
- `simple-git: ^3.32.3` (pre-existing)

---

## Mismatches with Plan

### 1. Sync Manager trigger call signature vs. runDigest signature
- **Plan says:** Contract 4 specifies `runDigest({ url, branch, localPath?, trigger? })`. Contract 2 (Webhook -> Sync Manager) passes `{ repoId, url, branch, commitSha, trigger }`. Contract 3 (Watcher -> Sync Manager) passes `{ repoId, url, branch, localPath, trigger }`.
- **Code actually:** `runDigest` accepts `DigestRequest { url, branch, localPath?, trigger? }`. It does NOT accept `repoId` or `commitSha` as input parameters. The `repoId` is resolved internally via upsert of `repositories` by URL. The `commitSha` is obtained internally (from clone result or from `simple-git` for local paths).
- **Downstream impact:** Phase 2's Sync Manager cannot pass `commitSha` into `runDigest` to pre-populate it. This means the Sync Manager cannot do a pre-flight "same SHA skip" check before invoking `runDigest` — the skip logic is inside `runDigest` itself (line 165-166). The `repoId` that the Sync Manager wants to use for `logSyncEvent` must be obtained from `DigestResult.repoId` after `runDigest` returns, or looked up separately.
- **Plan update:** The plan's Contract 2/3 `SyncTrigger` type can keep `repoId` and `commitSha` for the Sync Manager's own use (pre-flight skip, logging), but the Sync Manager should understand that `runDigest` only takes `{ url, branch, localPath?, trigger? }`. The Sync Manager should NOT pass `commitSha` to `runDigest`. If pre-flight SHA comparison is desired at the Sync Manager level (to avoid even calling `runDigest`), the Sync Manager should query `repositories.commit_sha` itself.

### 2. `last_synced_at` / `last_synced_sha` not written by runDigest
- **Plan says:** Flow 1 step 19 and Flow 2 step 17 state "Sync Manager updates repositories.last_synced_at and last_synced_sha." The plan expects the Sync Manager to write these columns after a successful digest.
- **Code actually:** `runDigest` updates `repositories.last_digest_at` and `repositories.commit_sha` (line 336-340) but does NOT update `last_synced_at` or `last_synced_sha`. These new columns exist in the migration but nothing writes to them.
- **Downstream impact:** Phase 2's Sync Manager must explicitly write `last_synced_at` and `last_synced_sha` after each successful sync. This is consistent with the plan (the plan says the Sync Manager does it, not runDigest). No code conflict, but Phase 3's frontend needs to know: `last_digest_at`/`commit_sha` are updated by the pipeline itself, while `last_synced_at`/`last_synced_sha` will be managed by the Sync Manager. These could diverge if someone runs a manual digest outside the Sync Manager.
- **Plan update:** Document that manual digests (via `POST /api/digest`) update `last_digest_at`/`commit_sha` but NOT `last_synced_at`/`last_synced_sha`. Consider whether the frontend should show both or just one. Alternatively, the Sync Manager could update `last_synced_at = last_digest_at` and `last_synced_sha = commit_sha` after any runDigest call (including manual ones triggered via Sync Manager).

### 3. Error handling: runDigest sets repo status to "error", plan says Sync Manager should NOT
- **Plan says:** Flow 5 step 5: "Sync Manager does NOT change repo status to 'error' (preserves last good state)."
- **Code actually:** In the catch block (digest.ts:352), `runDigest` sets `repositories.status = "error"` on failure.
- **Downstream impact:** When the Sync Manager catches a failed digest, the repo will already be in "error" status. The plan's intent was to keep the repo in "idle" so subsequent triggers aren't blocked. The Sync Manager would need to reset status back to "idle" after catching the error from `runDigest`, which is a workaround rather than a fix.
- **Plan update:** Either (a) modify `runDigest` to NOT set status to "error" when `trigger` is "webhook" or "watcher" (let the Sync Manager decide), or (b) have the Sync Manager reset status to "idle" after catching a sync-triggered failure. Option (a) is cleaner. Add to Phase 2 checklist: "When `trigger` is not 'manual', `runDigest` should set status to 'idle' instead of 'error' on failure, allowing the Sync Manager to handle error logging via sync_events."

### 4. `routes.ts` still uses `activeDigests` Set — plan says Phase 2 refactors this
- **Plan says:** Phase 2 checklist item: "Refactor `activeDigests` Set from `routes.ts` into SyncManager (single source of truth for concurrency)."
- **Code actually:** `routes.ts:11` still has `const activeDigests = new Set<string>()` used in the `POST /api/digest` handler (lines 45-73). This was not changed in Phase 1 (correct — it's a Phase 2 task).
- **Downstream impact:** No mismatch — this is expected. Phase 2 must replace this Set with Sync Manager calls. The `POST /api/digest` route should call `syncManager.trigger(...)` instead of directly calling `runDigest`.
- **Plan update:** None needed, just confirming this is correctly deferred.

### 5. Watcher-mode SHA skip logic
- **Plan says:** Flow 2 step 9: "runDigest detects localPath is provided -- SKIPS clone step." Flow 1 step 9: "Handler compares SHA against repositories.commit_sha — if same, return 200 (no changes)."
- **Code actually:** digest.ts lines 164-166: `const sameCommit = !isLocalPath && !isFirstDigest && repo.commit_sha === commitSha;` — the `!isLocalPath` guard means watcher-triggered digests NEVER skip even if the SHA is the same. This is intentional (comment on line 163: "For watcher-triggered digests, skip this check — files may have changed without a commit").
- **Downstream impact:** This is correct behavior but the plan should note it explicitly. Watcher digests always proceed to scan+diff, relying on the content-hash diffing (lines 198-213) rather than commit-SHA comparison. This means watcher syncs may do more work than webhook syncs (they always scan), but they catch uncommitted changes.
- **Plan update:** Add a note to the plan clarifying that watcher mode uses content-hash diffing (not SHA comparison) because local changes may be uncommitted.

### 6. `sync_events.files_added` never populated by current code
- **Plan says:** sync_events table has `files_added` and `files_removed` columns. Contract 5 specifies these are populated.
- **Code actually:** `diffFiles()` returns `{ changed, deleted }` — there is no separate "added" category. New files (not in storedHashes) are included in the `changed` array. The `DigestResult.stats` has `changedFiles` and `deletedFiles` but no `addedFiles`.
- **Downstream impact:** Phase 2's Sync Manager will need to decide how to populate `files_added`. It could count files in `changed` that had no previous hash (new files) vs files that had a different hash (modified). But that data is not exposed by `DigestResult` — only `changedFiles` (which combines new + modified) and `deletedFiles`.
- **Plan update:** Either (a) split `diffFiles` to return `{ added, modified, deleted }` and expose in DigestResult, or (b) simplify the sync_events schema to just `files_changed` and `files_removed` (dropping `files_added`), or (c) have the Sync Manager set `files_added = 0` and `files_changed = stats.changedFiles`. Option (b) is simplest and avoids misleading data.

---

## Hook Points for Phase 2

### 1. runDigest entry point
- **What:** The main digest pipeline function that Phase 2's Sync Manager calls.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/pipeline/digest.ts:112`
- **Exact signature:** `export async function runDigest(req: DigestRequest): Promise<DigestResult>`
- **Constraints:** Accepts `{ url, branch, localPath?, trigger? }`. Does NOT accept repoId or commitSha. Returns repoId in result. Throws on failure (caller must catch). Sets repo status to "error" on failure (see Mismatch #3 — Sync Manager may need to reset).

### 2. DigestRequest interface
- **What:** The input type for runDigest that the Sync Manager must construct.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/pipeline/digest.ts:9-16`
- **Exact interface:**
  ```typescript
  { url: string; branch: string; localPath?: string; trigger?: "manual" | "webhook" | "watcher" }
  ```
- **Constraints:** `url` is used as the repo's unique identifier (upserted on `onConflict: "url"`). `branch` is required. `localPath` triggers skip-clone behavior. `trigger` is stored but not currently used for control flow inside runDigest (only for logging/stats).

### 3. DigestResult interface
- **What:** The return type from runDigest that the Sync Manager uses for logging sync events.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/pipeline/digest.ts:18-34`
- **Key fields for Sync Manager:**
  - `repoId: string` — needed for sync_events INSERT
  - `incremental: boolean` — useful for logging
  - `stats.changedFiles?: number` — maps to sync_events.files_changed
  - `stats.deletedFiles?: number` — maps to sync_events.files_removed
  - `stats.durationMs: number` — maps to sync_events.duration_ms

### 4. Supabase sync columns on `repositories`
- **What:** New columns the Sync Manager reads/writes for sync mode and status.
- **Where:** `/Users/mattjones/Documents/RepoGraph/supabase-sync-migration.sql:5-9`
- **Exact columns:** `sync_mode TEXT`, `sync_config JSONB`, `last_synced_at TIMESTAMPTZ`, `last_synced_sha TEXT`
- **Constraints:** `sync_mode` defaults to `'off'`, `sync_config` defaults to `'{}'`. The Sync Manager must update `sync_mode` and `sync_config` when the user changes modes. The Sync Manager must update `last_synced_at` and `last_synced_sha` after successful syncs.

### 5. Supabase `sync_events` table
- **What:** Table the Sync Manager writes to after each sync attempt.
- **Where:** `/Users/mattjones/Documents/RepoGraph/supabase-sync-migration.sql:12-24`
- **Key columns:** `repo_id (UUID FK)`, `trigger (TEXT)`, `started_at`, `completed_at`, `files_changed (INT)`, `files_added (INT)`, `files_removed (INT)`, `duration_ms (INT)`, `status (TEXT)`, `error_log (TEXT)`
- **Constraints:** `repo_id` has ON DELETE CASCADE. `status` defaults to `'running'` — the Sync Manager should INSERT at sync start, then UPDATE to `'success'` or `'failed'` on completion.

### 6. activeDigests Set in routes.ts (to be replaced)
- **What:** Current concurrency guard that Phase 2 must replace with Sync Manager.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/routes.ts:11`
- **Current pattern:** `activeDigests.add(url)` before digest, `activeDigests.delete(url)` in finally block.
- **Constraints:** The `POST /api/digest` handler (routes.ts:25-74) awaits `runDigest` synchronously and returns the full result. Phase 2 should route this through `syncManager.trigger()` instead.

### 7. Express app and route registration
- **What:** Where the webhook route and sync API routes need to be mounted.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/index.ts:11`
- **Current pattern:** `app.use("/api", routes)` — all routes are on a single Router.
- **Constraints:** The webhook endpoint (`POST /api/webhooks/github`) can be added to the existing router in `routes.ts`, or a new router can be created and mounted. The `express.json()` middleware (index.ts:10) is already applied globally, but webhook signature validation needs the raw body. Phase 2 must add `express.raw()` middleware specifically for the webhook route OR use `JSON.stringify(req.body)` to reconstruct it (less reliable). Recommended: add a raw body capture middleware before `express.json()`.

### 8. Backend startup for watcher recovery
- **What:** The `start()` function where watcher recovery should be added.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/index.ts:13-75`
- **Constraints:** After connection verification (lines 17-30), add a call to `syncManager.restartWatchers()` or similar. The graceful shutdown handler (line 79-84) must also stop all active watchers.

### 9. Supabase client accessor
- **What:** The shared Supabase client the Sync Manager should use.
- **Where:** `/Users/mattjones/Documents/RepoGraph/packages/backend/src/db/supabase.ts:6`
- **Exact signature:** `export function getSupabase(): SupabaseClient`
- **Constraints:** Singleton pattern. Throws if env vars not set.

---

## New Opportunities

### 1. Content-hash diffing is well-abstracted
The `getStoredHashes()` (digest.ts:60-82) and `diffFiles()` (digest.ts:87-110) functions are clean, private utilities. If the Sync Manager ever needs to do a pre-flight diff check (e.g., to estimate change size before triggering), these could be extracted and exported. Currently private — consider exporting if Phase 2 needs them.

### 2. Incremental Neo4j threshold is configurable-ready
The `< 500` threshold for incremental vs. full-purge (digest.ts:250) is a hardcoded constant. This could be moved to `config.ts` for tuning. Not blocking, but a quick improvement.

### 3. `trigger` field flows through to DigestResult stats
The `trigger` field is accepted in `DigestRequest` but not included in `DigestResult`. The Sync Manager knows the trigger already, so this is fine, but it means digest_jobs don't record what triggered them. Consider adding `trigger` to the digest_jobs table for observability.

### 4. `purgeImportEdges` is a clean surgical tool
The new `purgeImportEdges(repoUrl)` in loader.ts:400-418 deletes both outgoing and incoming IMPORTS edges for a repo's files. This is exactly what the incremental path needs and could be useful for any future "refresh imports only" operation.

---

## Recommended Plan Updates

### Update 1: Clarify runDigest does not accept repoId or commitSha
In Contract 4, change:
> `runDigest({ url, branch, localPath?, trigger? })`

Add a note: "runDigest resolves repoId internally via upsert. commitSha is obtained internally from clone or simple-git. The Sync Manager should query `repositories.commit_sha` directly if it needs pre-flight SHA comparison."

### Update 2: Address error-status conflict
Add to Phase 2 checklist:
> "Modify `runDigest` catch block: when `trigger` is `'webhook'` or `'watcher'`, set `repositories.status = 'idle'` instead of `'error'`. This lets the Sync Manager control error reporting via sync_events without leaving the repo in a stuck 'error' state."

Alternatively, add to Sync Manager implementation:
> "After catching a runDigest failure for a sync-triggered digest, reset `repositories.status` to `'idle'` via Supabase update."

### Update 3: Simplify or split files_added vs files_changed
In the sync_events schema and Contract 5, either:
- (a) Remove `files_added` column (since the pipeline doesn't distinguish added from modified), or
- (b) Add a Phase 1.5 task: "Split `diffFiles` to return `{ added, modified, deleted }` and add `addedFiles` to DigestResult.stats."

Option (a) is recommended for simplicity.

### Update 4: Add raw body middleware note for webhook signature validation
Add to Phase 2 webhook checklist:
> "HMAC-SHA256 validation requires the raw request body. Since `express.json()` is applied globally before routes, add a raw body capture middleware: `app.use('/api/webhooks', express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));` — or configure `express.json` globally with the `verify` callback to always store `req.rawBody`."

### Update 5: Add watcher-mode content-hash note
In Flow 2 description, add a note after step 11:
> "Note: watcher mode always scans and diffs by content hash, never skipping by commit SHA. This catches uncommitted changes but means watcher syncs always perform a full scan."

### Update 6: Clarify dual timestamps
Add an architectural note:
> "`last_digest_at` / `commit_sha` are updated by `runDigest` on every successful digest (including manual). `last_synced_at` / `last_synced_sha` are updated only by the Sync Manager. For manual digests run outside the Sync Manager, `last_synced_*` will not update. Phase 3 frontend should display `last_synced_at` for repos with sync enabled, and `last_digest_at` for repos with sync off."
