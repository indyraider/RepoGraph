# Brainstorm: Continuous Sync

**Created:** 2026-03-06
**Status:** Draft

## Vision

Add automatic re-digestion to RepoGraph so the knowledge graph stays current as the developer builds. Two trigger modes: GitHub webhooks (push events trigger remote re-digest) and local file watching (filesystem changes trigger re-digest with debounce). This eliminates manual "Re-Digest" clicks and ensures Claude Code always works with fresh context.

## Existing Context

The codebase is fully built through Phase 3 of the original plan:

- **Backend API** (`packages/backend/src/`) — Express server with digest pipeline: clone → scan → parse → resolve → deps → load. Already supports incremental digests via content hash diffing (`digest.ts:56-106`). The `runDigest()` function accepts `{url, branch}` and handles the full pipeline.
- **Routes** (`routes.ts`) — `POST /api/digest`, `GET /api/repositories`, `GET /api/jobs/:id`, `DELETE /api/repositories/:id`, `GET /api/health`. Uses an `activeDigests` Set to prevent double-submits per URL.
- **Cloner** (`cloner.ts`) — Shallow clones via `simple-git`, returns `{localPath, commitSha}`.
- **Scanner** (`scanner.ts`) — Walks file tree with `fast-glob`, computes SHA-256 content hashes.
- **Loader** (`loader.ts`) — Batch upserts to Neo4j (nodes/edges) and Supabase (file contents). Has `purgeRepoFromNeo4j`, `removeFilesFromSupabase`, `removeFilesFromNeo4j`.
- **Frontend** (`packages/frontend/src/`) — React + Vite + Tailwind. Digest input zone, repo list with status badges, expand for details, Re-Digest and Delete buttons.
- **MCP Server** (`packages/mcp-server/src/index.ts`) — All 7 tools implemented: `search_code`, `get_file`, `get_repo_structure`, `get_symbol`, `get_dependencies`, `trace_imports`, `get_upstream_dep`, `query_graph`.
- **Supabase tables** — `repositories` (url, name, branch, commit_sha, last_digest_at, status), `digest_jobs`, `file_contents`.
- **Neo4j** — Full graph schema with Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport nodes and all relationship types.
- **Incremental digest** already works: `digest.ts` compares commit SHA (skip if same) and content hashes (only re-upload changed files to Supabase). However, it still purges and reloads the full Neo4j graph on every re-digest (`digest.ts:230`).
- **Job timeout checker** runs every 60s in `index.ts`, marks stuck jobs as failed after 10 minutes.
- **Concurrency guard** — `activeDigests` Set in `routes.ts` prevents parallel digests for the same URL.

## Components Identified

### 1. GitHub Webhook Endpoint (New)

- **Responsibility**: Receive GitHub push event payloads, validate webhook signature, extract repo URL + branch + commit SHA, and trigger an incremental digest if the SHA differs from the stored one.
- **Upstream (receives from)**: GitHub (HTTP POST with push event JSON payload + `X-Hub-Signature-256` header).
- **Downstream (sends to)**: Digest pipeline (`runDigest`); Supabase (sync_events logging).
- **External dependencies**: GitHub webhook configuration (user sets up in repo settings). `crypto` for HMAC-SHA256 signature validation.
- **Hands test**: PASS — Can call `runDigest()` directly. Needs the repo to already be registered in RepoGraph (URL must match a known repository). Signature validation uses Node.js built-in `crypto`.

### 2. Local File Watcher (New)

- **Responsibility**: Monitor a local directory for file changes. Debounce changes (configurable, default 30s). After debounce window closes, trigger an incremental digest using the local path instead of cloning.
- **Upstream (receives from)**: Filesystem events (create/modify/delete) via `chokidar`.
- **Downstream (sends to)**: Digest pipeline (modified to accept a local path directly, skipping clone); Supabase (sync_events logging).
- **External dependencies**: `chokidar` npm package for filesystem watching. Needs the watched path to be a git repo (to get commit SHA for tracking).
- **Hands test**: FAIL — **The current `runDigest()` always clones from a URL.** For local watching, we need to skip the clone step and scan the local path directly. `runDigest` must be refactored to accept an optional `localPath` parameter that bypasses cloning. Additionally, cleanup must NOT delete the watched directory (currently `cleanupClone` runs in the `finally` block).

### 3. Sync Manager (New)

- **Responsibility**: Manage the lifecycle of sync modes per repository. Start/stop watchers, track sync state, enforce one-digest-at-a-time concurrency per repo, coalesce rapid triggers (if a new push arrives during an active digest, queue it and skip to latest).
- **Upstream (receives from)**: Webhook endpoint (trigger); File watcher (trigger); API routes (sync mode changes).
- **Downstream (sends to)**: Digest pipeline; Supabase (sync_events, repository sync state).
- **External dependencies**: None beyond existing deps.
- **Hands test**: PASS — Orchestration logic, no external dependencies. But needs careful concurrency handling: the existing `activeDigests` Set in `routes.ts` is per-URL and lives in routes, not accessible to the sync manager. Must be refactored into a shared concurrency guard.

### 4. Sync API Routes (New)

- **Responsibility**: Expose endpoints for managing sync configuration: update sync mode, get sync status, list sync events.
- **Upstream (receives from)**: Frontend (HTTP requests).
- **Downstream (sends to)**: Sync Manager (start/stop watchers, update config); Supabase (sync config, sync events).
- **External dependencies**: None.
- **Hands test**: PASS — Standard Express routes calling into Sync Manager + Supabase.

### 5. Frontend Sync UI (Modified)

- **Responsibility**: Add sync mode controls to repo rows. Show sync status, webhook URL for copying, local path input for watcher mode, last synced timestamp, sync event log.
- **Upstream (receives from)**: Backend API (sync status, sync events).
- **Downstream (sends to)**: Backend API (sync mode updates).
- **External dependencies**: None.
- **Hands test**: PASS — Standard React UI calling API endpoints.

### 6. Supabase Schema Additions (Infrastructure)

- **Responsibility**: Add sync-related columns to `repositories` table and create `sync_events` table.
- **Upstream (receives from)**: Migration scripts.
- **Downstream (sends to)**: All components that read/write sync state.
- **External dependencies**: Hosted Supabase SQL editor or migration tool.
- **Hands test**: PASS — SQL DDL statements.

### 7. Digest Pipeline (Modified)

- **Responsibility**: Support two new modes: (a) accept a pre-existing local path instead of cloning, (b) true incremental Neo4j updates (update only changed files' graph nodes instead of purge-and-reload).
- **Upstream (receives from)**: Sync Manager, webhook endpoint, watcher, or manual trigger.
- **Downstream (sends to)**: Neo4j, Supabase (same as before).
- **External dependencies**: Same as existing pipeline.
- **Hands test**: FAIL — **Currently purges the entire Neo4j graph on every re-digest** (`digest.ts:230` calls `purgeRepoFromNeo4j`). For continuous sync to be fast (target: <15s for 1-20 files), we need truly incremental Neo4j updates: delete graph nodes for changed/deleted files, re-insert only those. The `removeFilesFromNeo4j` function already exists in `loader.ts:400-418` but is never called from `digest.ts`.

## Rough Dependency Map

```
GitHub Push Event                 Local File Changes
       |                                |
       v                                v
[Webhook Endpoint]            [File Watcher (chokidar)]
       |                                |
       +--------->  [Sync Manager]  <---+
                        |
                        v
               [Digest Pipeline]
              (modified: skip clone,
               incremental Neo4j)
                   |         |
                   v         v
              [Neo4j]    [Supabase]
                              |
                   +----------+----------+
                   |          |          |
              sync_events  repositories  file_contents

[Frontend] --HTTP--> [Sync API Routes] --> [Sync Manager]
                                       --> [Supabase]
```

## Open Questions

1. **Webhook URL accessibility**: The feature spec says the developer adds a webhook pointing to `http://<repograph-host>:PORT/api/webhooks/github`. But RepoGraph runs locally — GitHub can't reach localhost. Options: (a) use a tunneling service like ngrok (user's responsibility), (b) document this limitation, (c) add a GitHub polling mode as an alternative to webhooks. Polling would check for new commits via the GitHub API every N seconds — simpler but requires a GitHub token.

2. **Local watcher + clone path mismatch**: When a repo is registered via GitHub URL, the cloner creates a temp copy. The local watcher needs a persistent local path. This means the user must provide the local path where they're actively developing. The repo would then have two "identities": the GitHub URL (for graph queries that use `repo_url`) and the local path (for the watcher). Need to store both.

3. **True incremental Neo4j updates**: The current pipeline purges the entire graph and reloads. Making it truly incremental means: (a) delete all nodes/edges for changed files (symbols, imports, exports), (b) re-parse only changed files, (c) re-insert their nodes/edges, (d) re-resolve imports for those files. But import resolution is global — changing one file's exports can break import edges in OTHER files. How far do we go? Options: (a) re-resolve imports for the whole repo (current approach, just skip the purge for unchanged files), (b) only re-resolve imports involving changed files (faster but may miss cascading changes).

4. **Large diff fallback threshold**: The spec says >500 files should fall back to full re-digest. The current system already does full re-digest effectively (purge + reload). Is 500 the right number?

## Risks and Concerns

1. **Neo4j incremental update complexity**: The biggest risk. Truly incremental graph updates require careful handling of edge deletion (import edges involve two files — if file A imports from file B and file B changes, the edge must be updated). The existing `removeFilesFromNeo4j` deletes file nodes and their CONTAINS children, but doesn't clean up IMPORTS edges pointing TO those files from other files.

2. **Chokidar reliability**: File watchers can miss events under heavy I/O, especially on macOS (FSEvents has known quirks with rapid changes). The debounce window mitigates this, but edge cases exist.

3. **Memory usage with watchers**: Each active watcher holds file descriptors open. Watching a large repo (50K files) could consume significant memory. Chokidar's `usePolling: false` (native events) is more efficient but may miss some events.

4. **Concurrency during sync**: If a manual re-digest is triggered while a watcher-triggered digest is running, or two pushes arrive in quick succession, the system must handle this gracefully. The current `activeDigests` Set prevents parallel digests per URL, but the sync manager needs to queue and coalesce.

5. **Webhook security**: Without signature validation, anyone who discovers the webhook URL could trigger digests. The spec correctly calls for HMAC-SHA256 validation with a shared secret.

6. **Frontend complexity**: The sync UI adds significant state to the repo rows (sync mode, watcher status, last synced, sync events). This needs to be polled or use server-sent events to stay current.
