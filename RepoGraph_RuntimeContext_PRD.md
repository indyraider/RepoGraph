# RepoGraph Runtime Context — Product Requirements Document

**Live Local Development Context for Claude Code**

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | March 6, 2026 |
| **Status** | Draft |
| **Parent PRD** | RepoGraph PRD v1.0 |

---

## 1. Overview

Runtime Context is a RepoGraph feature that keeps the Neo4j knowledge graph continuously in sync with your local development environment as you write code. Instead of requiring a manual "digest" triggered from a web UI or a GitHub push, the graph updates automatically as files are saved — giving Claude Code a near-real-time structural understanding of the codebase at all times.

The goal is zero-friction context delivery: you write code, the graph updates, and Claude Code sees the latest state of your project the next time it queries. No manual steps, no stale snapshots.

---

## 2. Problem Statement

The base RepoGraph workflow (paste a GitHub URL, digest, query via MCP) creates a point-in-time snapshot. This is useful for onboarding Claude Code to a codebase, but breaks down during active development:

- The developer writes new code, adds files, refactors imports — but the graph still reflects the last digest.
- Re-digesting the full repo after every change is wasteful and slow (minutes for a medium repo).
- Claude Code gives answers based on stale graph data, leading to incorrect suggestions about imports, missing awareness of newly created functions, or outdated call chains.
- The developer has to remember to re-digest, which adds friction and breaks flow.

Runtime Context solves this by watching the local project directory and incrementally updating the graph on every file save, keeping Claude Code's view of the codebase within seconds of reality.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Watch a local project directory for file changes (create, modify, delete, rename) and incrementally update the Neo4j graph within seconds.
2. Only re-parse changed files — never re-digest the full repo for a single file change.
3. Maintain full graph consistency: when a file's imports change, update the corresponding edges, not just the file node.
4. Expose the same MCP tools as base RepoGraph — Claude Code should not need to know whether the graph was built from a GitHub digest or runtime context.
5. Support multiple watched projects simultaneously.
6. Run as a lightweight background daemon with minimal CPU and memory overhead during idle periods.

### 3.2 Non-Goals

- Tracking unsaved in-editor buffer changes (file-save granularity is sufficient).
- Replacing the GitHub digest flow (runtime context complements it — digest for initial load, watcher for ongoing sync).
- Version history or undo (the graph reflects current state only, not a timeline).
- Watching node_modules or other dependency directories (upstream deps are handled separately via lockfile parsing).

---

## 4. System Architecture

### 4.1 Components

| Component | Technology | Responsibility |
|---|---|---|
| File Watcher | chokidar (Node.js) or watchman (Facebook) | Detect file system events in watched project directories |
| Change Queue | In-memory queue with debounce | Batch rapid successive saves into single update operations |
| Incremental Parser | tree-sitter (same as base RepoGraph) | Re-parse only changed files, extract updated symbols and relationships |
| Graph Diff Engine | Custom (TypeScript) | Compare old graph state for a file against new parse result, compute minimal set of node/edge mutations |
| Graph Writer | Neo4j driver (batched transactions) | Apply mutations to Neo4j atomically per file |
| Daemon Process | Node.js long-running process | Orchestrates watcher → queue → parser → diff → writer pipeline |
| Status API | Express endpoint (lightweight) | Health check, list watched projects, stats (files tracked, last update, queue depth) |

### 4.2 Data Flow

```
File saved on disk
       │
       ▼
┌─────────────┐
│ File Watcher │  ← chokidar / watchman
└──────┬──────┘
       │  (file path + event type)
       ▼
┌─────────────┐
│ Change Queue │  ← debounce 300ms, deduplicate by path
└──────┬──────┘
       │  (batch of changed file paths)
       ▼
┌──────────────────┐
│ Incremental Parse │  ← tree-sitter on changed files only
└──────┬───────────┘
       │  (new AST nodes + relationships for each file)
       ▼
┌──────────────────┐
│ Graph Diff Engine │  ← compare against current Neo4j state
└──────┬───────────┘
       │  (minimal mutations: create/update/delete nodes + edges)
       ▼
┌──────────────┐
│ Graph Writer  │  ← single Neo4j transaction per batch
└──────┬───────┘
       │
       ▼
  Graph is current
  Claude Code sees latest state
```

### 4.3 Event Handling by Type

| Event | Action |
|---|---|
| **File created** | Parse file → create File node, symbol nodes, and all edges → attach to Repository |
| **File modified** | Re-parse file → diff against existing nodes → update changed symbols, add new ones, remove deleted ones → update edges |
| **File deleted** | Remove File node and all CONTAINS, IMPORTS, EXPORTS edges → cascade-remove orphaned symbol nodes that existed only in this file |
| **File renamed** | Treat as delete + create. Update all IMPORTS edges from other files that referenced the old path. |
| **Directory created** | No action (directories are not nodes; files within them trigger individual events) |
| **Directory deleted** | Triggers individual delete events for all contained files |

---

## 5. Incremental Parse Strategy

### 5.1 Debouncing & Batching

File watchers fire events rapidly during normal development (auto-save, formatter runs, branch switches). The change queue debounces and batches:

- **Debounce window:** 300ms after the last event for a given file path before processing.
- **Batch window:** 500ms to collect multiple file changes into a single processing batch.
- **Branch switch detection:** If more than 50 files change within 2 seconds, treat it as a bulk event (likely a branch switch or git operation) and trigger a lightweight re-scan instead of individual incremental updates.
- **Max batch size:** 100 files per batch. If a batch exceeds this, split into sequential batches to avoid Neo4j transaction timeouts.

### 5.2 Diff Algorithm

For each changed file, the incremental parser:

1. **Fetches the existing state** from Neo4j: all nodes and edges associated with this file's path.
2. **Parses the new file content** with tree-sitter to produce a fresh set of symbols and relationships.
3. **Computes a diff** by comparing old and new symbol sets:
   - Symbols matched by (name + kind) → check if signature, docstring, or line numbers changed → update if different.
   - Symbols in new but not old → create new nodes and edges.
   - Symbols in old but not new → delete nodes and cascade-remove orphaned edges.
4. **Updates import edges** by comparing old and new import statements. If file A now imports from file C instead of file B, the IMPORTS edge is redirected.

### 5.3 Consistency Guarantees

- **Atomic per-file:** All mutations for a single file happen in one Neo4j transaction. The graph is never in a half-updated state for any given file.
- **Eventually consistent across files:** If file A and file B both change in the same save (e.g., a refactor), they may be processed in separate transactions. For a brief window (milliseconds), the graph may reflect the new A but old B. This is acceptable for the use case.
- **Crash recovery:** On daemon restart, do a quick scan of all watched files against their stored content_hash in Neo4j. Re-parse any files whose hash has changed since the last recorded state.

---

## 6. Watched Project Configuration

### 6.1 Registration

Projects are registered for watching via the web UI or a CLI command:

```bash
# Via CLI
repograph watch /path/to/qwikr --name qwikr

# Or via API
POST /api/watch
{ "path": "/path/to/qwikr", "name": "qwikr" }
```

### 6.2 Watch Configuration

Each watched project supports the following config:

| Setting | Default | Description |
|---|---|---|
| path | (required) | Absolute path to the local project root |
| name | Directory name | Display name for the project |
| ignore_patterns | node_modules, .git, dist, build, __pycache__, .next, .turbo | Glob patterns for directories/files to skip |
| languages | auto-detect | Limit parsing to specific languages (e.g., typescript, python) |
| debounce_ms | 300 | Debounce window for file events |
| enabled | true | Toggle watching on/off without removing the config |

### 6.3 Ignore Patterns

The default ignore list is designed for typical JS/TS and Python projects. It should always exclude:

- Version control: `.git`
- Dependencies: `node_modules`, `.venv`, `site-packages`, `vendor`
- Build output: `dist`, `build`, `.next`, `.turbo`, `__pycache__`, `.pyc`
- IDE config: `.idea`, `.vscode` (unless explicitly opted in)
- Lock files and generated code: watched but parsed differently (lockfile parser, not tree-sitter)

Users can extend or override ignore patterns per project.

---

## 7. Daemon Specification

### 7.1 Lifecycle

The runtime context daemon runs as a background process alongside (or embedded within) the RepoGraph server.

| State | Behavior |
|---|---|
| **Starting** | Load watch configs from Supabase. Initialize file watchers for all enabled projects. Run crash recovery scan. |
| **Running** | Process file events through the pipeline. Serve status API. |
| **Idle** | No file events in queue. Watchers are active but pipeline is dormant. Near-zero CPU usage. |
| **Paused** | Watchers still active but events are queued without processing. Useful during known bulk operations (e.g., npm install). |
| **Stopping** | Drain the current batch, close watchers, flush any pending writes. |

### 7.2 Resource Constraints

| Resource | Target | Rationale |
|---|---|---|
| Memory (idle) | < 50MB | Watcher metadata + queue buffer |
| Memory (processing) | < 200MB | tree-sitter AST for batch of files |
| CPU (idle) | < 1% | File watcher polling only |
| CPU (processing) | Brief spike, < 2 seconds per file | Single file parse + diff + write |
| Disk I/O | Minimal | Reads changed files only; writes go to Neo4j over network |

### 7.3 Logging

The daemon logs to a rotating log file and exposes recent logs via the status API:

- **INFO:** Project watched, file processed, batch completed.
- **WARN:** Parse failure on a file (fallback to raw content indexing), large batch detected (possible branch switch).
- **ERROR:** Neo4j connection failure, watcher crash, unrecoverable parse error.

---

## 8. Integration with Base RepoGraph

### 8.1 Coexistence with GitHub Digest

Runtime context and GitHub digest are complementary, not competing:

| Scenario | Recommended Flow |
|---|---|
| First time indexing a repo | GitHub digest (full clone + parse) to populate the initial graph |
| Ongoing development | Runtime context (file watcher) to keep the graph in sync |
| Switching branches | Watcher detects bulk file changes and triggers a lightweight re-scan |
| Pulling upstream changes | Watcher picks up changed files after git pull completes |
| CI/CD or remote context | GitHub digest (runtime context only works for local directories) |

### 8.2 Graph Namespace

Each watched project maps to the same Repository node in Neo4j that a GitHub digest would create. The watcher updates the same nodes — it does not create a separate graph. This means:

- A GitHub digest followed by enabling runtime context is seamless: the watcher takes over maintaining the graph.
- Re-running a GitHub digest while the watcher is active will overwrite the graph with the GitHub snapshot, then the watcher resumes incremental updates from there.
- The `last_digest_at` property on the Repository node is updated on every watcher batch, so MCP tools can report how fresh the data is.

### 8.3 MCP Tool Behavior

No changes to MCP tool definitions. The same tools (search_code, get_file, get_symbol, etc.) work identically whether the graph was populated by a digest or by the runtime watcher. Claude Code does not need to know the difference.

One addition: the `get_repo_structure` tool should include a `last_updated` field in its response so Claude can assess graph freshness.

---

## 9. Phased Delivery Plan

### Phase 1 — File Watcher + Raw Content Sync

**Goal:** Watch a local directory and keep File nodes and raw content in sync.
**Duration:** 1 week

- chokidar-based file watcher with debounce and batching.
- On file change: update File node properties (content_hash, size_bytes) and raw content in Supabase.
- On file create/delete: create/remove File nodes and CONTAINS_FILE edges.
- CLI command to register a watched project.
- Basic daemon lifecycle (start, stop, status).

**Exit Criteria:** Claude Code sees newly created or modified files within 5 seconds of saving, without manual re-digest.

### Phase 2 — Incremental Structural Parse

**Goal:** Update symbol nodes and relationship edges incrementally on file change.
**Duration:** 2 weeks

- tree-sitter incremental parse on changed files.
- Graph diff engine: compare old vs new symbols, compute minimal mutations.
- Atomic per-file Neo4j transactions.
- Handle file renames (delete + create + update inbound IMPORTS edges).
- Branch switch detection (bulk change heuristic → lightweight re-scan).

**Exit Criteria:** After refactoring a function signature in file A, Claude Code immediately sees the updated signature and can identify all callers that may need updating.

### Phase 3 — Resilience & Observability

**Goal:** Make the daemon reliable for daily all-day use.
**Duration:** 1 week

- Crash recovery scan on daemon restart.
- Pause/resume support for bulk operations.
- Status API with health check, watched project list, queue depth, recent logs.
- Surface watcher status in the RepoGraph web UI.
- Rotating log files.
- Graceful handling of Neo4j connection drops (retry with backoff, queue events in memory).

**Exit Criteria:** The daemon runs all day without intervention, recovers from crashes, and the developer can check watcher health from the web UI.

---

## 10. Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Time from file save to graph update | < 2 seconds | Includes debounce (300ms) + parse + diff + write |
| Single file incremental parse | < 500ms | tree-sitter parse + diff computation |
| Neo4j write (single file batch) | < 200ms | Batched transaction for all mutations from one file |
| Branch switch re-scan (1K changed files) | < 30 seconds | Parallel parse, batched Neo4j writes |
| Memory overhead (idle, 3 watched projects) | < 50MB | chokidar watchers + queue buffers |
| CPU overhead (idle) | < 1% | Watcher polling only |

---

## 11. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| File watcher misses events (OS limits, rapid changes) | Medium | Periodic reconciliation scan (every 5 minutes) compares file hashes against Neo4j. Catches any missed events. |
| Branch switch floods the queue with thousands of events | Medium | Bulk change detection heuristic. If > 50 files change in < 2 seconds, switch to lightweight full re-scan instead of individual incremental updates. |
| Neo4j write contention with concurrent MCP reads | Low | MCP reads are non-blocking in Neo4j. Write transactions are short (< 200ms per file). No practical contention at single-developer scale. |
| Large files cause slow parses (e.g., generated code, minified bundles) | Low | Skip files > 1MB by default (configurable). These are almost always generated and not useful for the graph. |
| Watcher daemon crashes and graph becomes stale | Medium | Crash recovery scan on restart. Systemd/launchd service config for auto-restart. Staleness indicator in MCP responses. |
| Rename detection is imperfect (some watchers report delete + create instead of rename) | Low | Treat delete + create of same filename in different path within a short window as a potential rename. Update inbound edges heuristically. Worst case: edges are recreated, not lost. |

---

## 12. Success Criteria

1. A developer working on Qwikr can save a file and have Claude Code see the change within 2 seconds, with no manual action required.
2. After a refactor that moves or renames symbols, Claude Code's suggestions reflect the new structure on its next query.
3. The daemon runs for a full workday (8+ hours) without requiring restart or manual intervention.
4. Memory and CPU overhead is imperceptible during normal development — the developer never notices the watcher is running.
5. Switching branches and pulling changes are handled gracefully without corrupting the graph or requiring a full re-digest.
