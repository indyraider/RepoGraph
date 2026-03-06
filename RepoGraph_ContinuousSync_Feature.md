# RepoGraph Feature Addon: Continuous Sync

## Summary

Add the ability for RepoGraph to automatically re-digest a repository whenever new commits are pushed, so the Neo4j knowledge graph stays current as the developer builds. This eliminates the need to manually click "Re-Digest" and ensures Claude Code always has access to the latest codebase state.

---

## Problem

The base RepoGraph system creates a point-in-time snapshot of a repo. As the developer continues building features, the graph becomes stale. Manually re-digesting after every meaningful change adds friction and is easy to forget, which means Claude Code ends up working with outdated context.

---

## Proposed Solution

Support two sync modes that keep the graph up to date automatically:

### Mode 1: GitHub Webhook (Remote Trigger)

A lightweight webhook endpoint on the RepoGraph backend that GitHub calls on every push event.

**How it works:**

1. Developer adds a webhook in their GitHub repo settings pointing to `http://<repograph-host>:PORT/api/webhooks/github`.
2. On each push, GitHub sends a payload containing the repo URL, branch, and commit SHA.
3. RepoGraph compares the incoming SHA against the last digested SHA in Supabase.
4. If different, it queues an incremental re-digest job (only re-parse changed files based on the Git diff).
5. The MCP server continues serving the previous graph until the new digest completes, then swaps atomically.

**Best for:** Repos hosted on GitHub where the developer pushes frequently.

### Mode 2: Local File Watcher (No GitHub Required)

A filesystem watcher that monitors a local repo directory and triggers re-digestion on file changes.

**How it works:**

1. Developer registers a local path instead of (or in addition to) a GitHub URL in the RepoGraph UI.
2. RepoGraph starts a file watcher (using chokidar or similar) on that directory.
3. On file changes, it debounces for a configurable interval (default: 30 seconds of inactivity) to avoid thrashing during active editing.
4. After the debounce window, it diffs changed files against the last digest and runs an incremental update.
5. Only touched files are re-parsed and their graph nodes/edges are replaced in Neo4j.

**Best for:** Local development where the developer wants near-real-time sync without pushing to GitHub.

---

## Incremental Digest Logic

Both modes depend on an incremental digest engine (already scoped as Phase 4 in the PRD). The key behaviors:

- **Diff detection:** Compare the current file tree + content hashes against the stored `content_hash` values in Supabase's `file_contents` table.
- **Changed files only:** Re-parse only files whose hash has changed. Delete graph nodes for removed files. Add nodes for new files.
- **Edge rebuilding:** When a file is re-parsed, delete all edges originating from that file's nodes, then re-resolve imports/exports/calls from the new AST.
- **Atomic swap:** Write new nodes/edges to Neo4j in a transaction. The MCP server sees a consistent graph at all times.

---

## UI Changes

Minimal additions to the existing RepoGraph UI:

- **Sync mode toggle** on each repo row: Off / Webhook / Local Watcher.
- When Webhook is selected, display the webhook URL to copy into GitHub settings.
- When Local Watcher is selected, show a path input field and a status indicator (watching / paused / error).
- **Last synced** timestamp that updates automatically so the developer can see at a glance how fresh the graph is.
- **Sync log** expandable section showing recent auto-digest events (timestamp, trigger type, files changed count, duration).

---

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/webhooks/github` | POST | Receive GitHub push events, validate payload, queue incremental digest |
| `/api/repos/:id/sync` | PUT | Update sync mode and config (webhook / watcher / off) |
| `/api/repos/:id/sync/status` | GET | Return current sync state, last synced SHA, watcher status |

---

## Supabase Schema Additions

Add to the existing `repositories` table:

```
sync_mode       TEXT        -- 'off' | 'webhook' | 'watcher'
sync_config     JSONB       -- { debounce_ms, local_path, webhook_secret }
last_synced_at  TIMESTAMPTZ -- last successful incremental digest
last_synced_sha TEXT        -- commit SHA or content hash of last sync
```

Add a new `sync_events` table:

```
id              UUID PRIMARY KEY
repo_id         UUID REFERENCES repositories(id)
trigger         TEXT        -- 'webhook' | 'watcher' | 'manual'
started_at      TIMESTAMPTZ
completed_at    TIMESTAMPTZ
files_changed   INT
files_added     INT
files_removed   INT
duration_ms     INT
status          TEXT        -- 'success' | 'failed'
error_log       TEXT
```

---

## Tech Considerations

- **Debounce tuning:** The local watcher default of 30 seconds balances freshness vs. CPU usage. Make it configurable per repo.
- **Webhook security:** Validate GitHub webhook signatures using a shared secret to prevent unauthorized triggers.
- **Concurrency:** Only one digest job per repo at a time. If a new push arrives while digesting, queue it and coalesce (skip intermediate commits, jump to latest).
- **Large diffs:** If a push touches more than 500 files (e.g., a dependency update or major refactor), fall back to a full re-digest rather than incremental.

---

## Implementation Priority

This feature layers on top of Phase 4 (incremental re-digest) from the main PRD. Suggested order:

1. Build the incremental digest engine first (diff + selective re-parse).
2. Add the GitHub webhook endpoint (Mode 1) — simplest trigger mechanism.
3. Add the local file watcher (Mode 2) — more complex but higher value for active development.

---

## Success Criteria

- After pushing a commit to GitHub, the knowledge graph reflects the changes within 60 seconds without manual intervention.
- With the local watcher active, Claude Code sees file changes within 90 seconds of the developer saving a file.
- Incremental digests for typical changes (1–20 files) complete in under 15 seconds.
- No data corruption or inconsistent graph state during concurrent reads (MCP queries) and writes (digest updates).
