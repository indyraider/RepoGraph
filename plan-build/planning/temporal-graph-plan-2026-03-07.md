# Build Plan: Temporal Graph (Code Evolution Over Time)
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/temporal-graph-brainstorm-2026-03-07.md
**PRD:** repograph-temporal-graph-prd.md
**Status:** Draft

## Overview

Add temporal versioning to the RepoGraph code graph so every node and edge carries `valid_from`/`valid_to` fields keyed to commit SHAs and timestamps. This enables structural blame, dependency evolution tracking, and complexity trend analysis via 6 new MCP tools + enrichment of 5 existing tools with an `at_commit` parameter. The build modifies the Clone stage, adds a Diff stage between Resolve and Load, rewrites the Load stage to version instead of overwrite, and adds a historical backfill mode.

## Component Inventory

| # | Component | New/Modify | Inputs | Outputs | Key Dependencies |
|---|-----------|-----------|--------|---------|-----------------|
| 1 | Schema Migration | New | — | Temporal fields on Neo4j nodes/edges; new Supabase tables | Neo4j, Supabase |
| 2 | Clone Stage Modifier | Modify | `DigestRequest` + new `historyDepth` | Full/configurable clone + commit metadata | `simple-git`, `cloner.ts` |
| 3 | Commit History Ingester | New | Cloned repo path | Commit nodes in Neo4j, rows in Supabase `commits` | `simple-git`, Neo4j, Supabase |
| 4 | Diff Engine | New | Current resolve output + previous graph state (Neo4j) | Changeset: created/modified/deleted nodes+edges | Neo4j read queries |
| 5 | Temporal Loader | Modify | Changeset + commit metadata | Versioned nodes/edges in Neo4j, INTRODUCED_IN edges | Neo4j, existing loader patterns |
| 6 | Digest Orchestrator Update | Modify | All of the above | Updated `runDigest()` flow | `digest.ts` |
| 7 | Complexity Metrics | New | Graph state per commit | Supabase `complexity_metrics` rows | Supabase |
| 8 | Historical Backfill | New | Full clone + commit list | Temporal graph across N commits | All pipeline stages |
| 9 | New MCP Temporal Tools | New | Neo4j temporal graph, Supabase metrics | 6 new tool endpoints | MCP SDK, Neo4j, Supabase |
| 10 | Existing MCP Tool Enrichment | Modify | `at_commit` parameter | Temporal-filtered query results | Neo4j temporal indexes |

## Integration Contracts

### Contract 1: DigestRequest → Clone Stage
```
DigestRequest → cloneRepo()
  What flows:     DigestRequest with new optional `historyDepth?: number`
  How it flows:   Function parameter. Default `historyDepth = 1` (current behavior).
                  When > 1, clone with `--depth N` instead of `--depth 1`.
                  When `historyDepth = 0`, full clone (no depth limit).
  Auth/Config:    Same as current (GITHUB_TOKEN for private repos)
  Error path:     Same as current — PrivateRepoError on auth failure
```
**Verified via RepoGraph:** `cloneRepo()` at `cloner.ts:51` currently hardcodes `["--depth", "1"]`. The `simple-git` `.clone()` method accepts options array — changing `"1"` to a variable is trivial.

### Contract 2: Clone Stage → Commit History Ingester
```
cloneRepo() → ingestCommitHistory()
  What flows:     localPath (string), commitSha (string), historyDepth (number)
  How it flows:   Function call from runDigest() after cloneRepo() returns
  Auth/Config:    None — reads from local .git directory
  Error path:     If git log fails (shallow clone, corrupt repo), skip history
                  ingestion and proceed with snapshot-only mode. Log warning.
```

### Contract 3: Commit History Ingester → Neo4j + Supabase
```
ingestCommitHistory() → Neo4j (Commit nodes) + Supabase (commits table)
  What flows:     Array of CommitMeta: { sha, author, authorEmail, timestamp,
                  message, parentShas }
  How it flows:   Batch Cypher: MERGE Commit nodes, CREATE HAS_COMMIT edges
                  from Repository, CREATE PARENT_OF edges between Commits.
                  Batch Supabase insert to `commits` table.
  Auth/Config:    Neo4j session (getSession()), Supabase client (getSupabase())
  Error path:     Transaction failure → rollback, log error, continue digest
                  without history. Digest should not fail because of commit
                  ingestion failure.
```

### Contract 4: Resolve Stage → Diff Engine
```
resolveImports() output → diffGraph()
  What flows:     Current state: { allSymbols: ParsedSymbol[],
                  allImports: ResolvedImport[], allExports: ParsedExport[],
                  callsEdges: CallsEdge[], allFiles: ScannedFile[] }
                  Previous state: queried from Neo4j (valid_to IS NULL)
  How it flows:   Function call. Diff engine queries Neo4j for current nodes
                  (Functions, Classes, TypeDefs, Constants, IMPORTS edges, CALLS
                  edges, etc.) filtered to valid_to IS NULL. Compares against
                  the resolve output using identity keys.
  Auth/Config:    Neo4j read session
  Error path:     If previous state query fails, treat as first digest (no diff,
                  all nodes are "created"). If identity matching is ambiguous,
                  log warnings and treat as delete+create rather than modify.
```

### Contract 5: Diff Engine → Temporal Loader
```
diffGraph() → temporalLoad()
  What flows:     GraphChangeset: {
                    created: { nodes: VersionedNode[], edges: VersionedEdge[] },
                    modified: { nodes: { old: VersionedNode, new: VersionedNode }[],
                                edges: { old: VersionedEdge, new: VersionedEdge }[] },
                    deleted: { nodes: VersionedNode[], edges: VersionedEdge[] }
                  }
  How it flows:   Return value from diffGraph(), passed to temporalLoad()
  Auth/Config:    None (in-memory data structure)
  Error path:     Empty changeset = no-op (no changes to write)
```

### Contract 6: Temporal Loader → Neo4j
```
temporalLoad() → Neo4j
  What flows:     For CREATED: INSERT node with valid_from=commitSha,
                  valid_from_ts=commitTs, valid_to=null, change_type="created",
                  changed_by=author, commit_message=message.
                  CREATE (node)-[:INTRODUCED_IN]->(commit)

                  For MODIFIED: SET old_node.valid_to=commitSha,
                  old_node.valid_to_ts=commitTs. INSERT new version with
                  valid_from=commitSha, change_type="modified".
                  CREATE (new_node)-[:INTRODUCED_IN]->(commit)

                  For DELETED: SET node.valid_to=commitSha,
                  node.valid_to_ts=commitTs, node.change_type="deleted".
                  CREATE (node)-[:INTRODUCED_IN {change_type: "deleted"}]->(commit)

  How it flows:   Batch Cypher transactions (same batching pattern as existing
                  loader: UNWIND $batch, groups of BATCH_SIZE)
  Auth/Config:    Neo4j session (getSession())
  Error path:     Transaction failure → rollback, throw to digest orchestrator
```

### Contract 7: Temporal Loader → Complexity Metrics
```
temporalLoad() → computeComplexityMetrics()
  What flows:     repoUrl, commitSha, commitTimestamp
  How it flows:   Function call after temporal load completes. Queries Neo4j
                  for per-file metrics at current commit state.
  Auth/Config:    Neo4j read session, Supabase write client
  Error path:     Metrics computation failure is non-fatal. Log warning,
                  continue digest.
```

### Contract 8: MCP Tools → Neo4j Temporal Queries
```
MCP tool handler → Neo4j (via Cypher)
  What flows:     Tool parameters including optional at_commit/at_date.
                  Without temporal param: WHERE valid_to IS NULL (current state).
                  With temporal param: WHERE valid_from_ts <= $ts AND
                  (valid_to_ts IS NULL OR valid_to_ts > $ts)
  How it flows:   Cypher query from MCP tool handler, same pattern as existing
  Auth/Config:    Neo4j session (getSession() in MCP server)
  Error path:     If temporal fields don't exist (repo never temporal-digested),
                  fall back to unfiltered query (backward compatible).
```

### Contract 9: MCP Temporal Tools → Supabase
```
get_complexity_trend → Supabase complexity_metrics table
  What flows:     repo, path, metric, since, granularity
  How it flows:   Supabase query with filters and aggregation
  Auth/Config:    Supabase client (getSupabase() in MCP server)
  Error path:     Empty result if no metrics exist yet (repo hasn't run
                  temporal digest). Return empty array, not error.
```

## End-to-End Flows

### Flow 1: First Temporal Digest (Snapshot Mode)

```
1.  User triggers digest with historyDepth=1 (or default)
2.  runDigest() receives DigestRequest
3.  cloneRepo() clones with --depth 1 (same as today)
4.  scanRepo() scans files → ScannedFile[]
5.  parseFile() parses each file → symbols, imports, exports
6.  runScipStage() runs type analysis → callsEdges, symbolTable
7.  resolveImports() resolves import paths → ResolveResult
8.  ingestCommitHistory() creates 1 Commit node for HEAD commit
9.  diffGraph() finds no previous state → all nodes are "created"
10. temporalLoad() inserts all nodes with valid_from=HEAD, valid_to=null,
    change_type="created". Creates INTRODUCED_IN edges to HEAD Commit.
11. computeComplexityMetrics() computes per-file metrics for HEAD
12. loadToSupabase() stores file contents (same as today)
13. Update digest_jobs and repositories in Supabase
14. Return DigestResult
```

### Flow 2: Incremental Temporal Digest

```
1.  User pushes code, webhook/watcher triggers digest
2.  runDigest() receives DigestRequest
3.  cloneRepo() clones with --depth 2 (need parent for diff context)
4.  Same-commit check: if HEAD SHA matches stored SHA, skip (same as today)
5.  scanRepo() → ScannedFile[]
6.  diffFiles() identifies changed/deleted files by content_hash
7.  Parse ALL files (import resolution needs full set, same as today)
8.  runScipStage() → callsEdges, symbolTable
9.  resolveImports() → ResolveResult
10. ingestCommitHistory() creates Commit node for new HEAD
11. diffGraph() queries Neo4j for previous state (valid_to IS NULL),
    compares against current resolve output:
    - Identifies created symbols (new functions/classes/types)
    - Identifies modified symbols (same identity, changed properties)
    - Identifies deleted symbols (in previous state, not in current)
    - Identifies created/modified/deleted edges (IMPORTS, CALLS, etc.)
12. temporalLoad():
    - For created nodes: INSERT with valid_from=HEAD
    - For modified nodes: SET old.valid_to=HEAD, INSERT new with valid_from=HEAD
    - For deleted nodes: SET old.valid_to=HEAD, change_type="deleted"
    - Same pattern for edges
    - CREATE INTRODUCED_IN edges for all changes
13. computeComplexityMetrics() for HEAD commit
14. loadToSupabase() stores file contents for changed files
15. Update digest_jobs and repositories
16. Return DigestResult with temporal stats
```

### Flow 3: Historical Backfill

```
1.  User explicitly triggers backfill with historyDepth=100 (or date cutoff)
2.  cloneRepo() clones with --depth 100 (or full clone)
3.  git log extracts commit list: [oldest → newest]
4.  For each commit (from oldest to newest):
    a. git diff --name-only vs previous commit → changedPaths
    b. git checkout commit SHA
    c. scanRepo() scans only changedPaths (carry forward unchanged)
    d. parseFile() parses changed files
    e. resolveImports() resolves (using full file set: carried forward + changed)
    f. SKIP SCIP (too expensive per commit — only run for HEAD)
    g. diffGraph() compares against previous commit's graph state
    h. temporalLoad() writes versioned changes
    i. computeComplexityMetrics() for this commit
    j. Update progress in temporal_digest_jobs
5.  Mark backfill complete
6.  Return backfill stats (commits processed, duration, changes found)
```

### Flow 4: MCP Temporal Query (get_symbol_history)

```
1.  Claude Code calls get_symbol_history(name="processPayment")
2.  MCP server handler receives request
3.  Cypher query:
    MATCH (f:Function {name: $name, repo_url: $repo})
    OPTIONAL MATCH (f)-[:INTRODUCED_IN]->(c:Commit)
    RETURN f.signature, f.valid_from, f.valid_from_ts, f.valid_to,
           f.valid_to_ts, f.change_type, f.changed_by, c.message
    ORDER BY f.valid_from_ts DESC
4.  Return version history with attribution
```

### Flow 5: Error Path — Temporal Digest on Non-Temporal Repo

```
1.  Existing repo with no temporal fields runs incremental digest
2.  diffGraph() queries for previous state (valid_to IS NULL)
3.  No nodes have valid_to field → query returns all nodes (no filter match)
4.  Diff engine treats this as "no previous temporal state"
5.  Falls back to: all current nodes are "created" at this commit
6.  temporalLoad() adds temporal fields to all existing nodes
7.  This is effectively a one-time migration for existing repos
```

## Issues Found

### 1. Clone Depth Hardcoded
- **Location:** `cloner.ts:63` — `["--depth", "1"]`
- **Impact:** Cannot access commit history for temporal features
- **Fix:** Accept `depth` parameter, default to 1 for backward compatibility. Use `["--depth", String(depth)]` or omit for full clone when depth=0.

### 2. Loader Uses MERGE (Overwrite) — Incompatible with Versioning
- **Location:** `loader.ts:11-63` (`loadToNeo4j`), `loader.ts:65-235` (`loadSymbolsToNeo4j`), `loader.ts:237-346` (`loadImportsToNeo4j`), `loader.ts:527-572` (`loadCallsToNeo4j`)
- **Impact:** All four functions use `MERGE ... SET` which overwrites the existing node. Temporal versioning needs close-out + insert.
- **Fix:** Create new temporal-aware versions of these functions that:
  1. Close out existing version: `SET node.valid_to = $sha, node.valid_to_ts = $ts`
  2. Create new version: `CREATE (node:Label {..., valid_from: $sha, valid_from_ts: $ts, valid_to: null})`
  Keep the original functions for backward compatibility (non-temporal digests still work).

### 3. Import/CALLS Edge Purge-and-Reload Strategy Won't Work
- **Location:** `digest.ts:393-396` — `purgeImportEdges()` then `loadImportsToNeo4j()`
- **Impact:** Currently all import edges are deleted and recreated on every incremental digest. With temporal versioning, this would destroy history.
- **Fix:** The diff engine must diff edges individually. For imports: compare current IMPORTS edges (from resolve output) against stored edges (valid_to IS NULL). Close out removed edges, create new edges, update modified edges. Same for CALLS edges.

### 4. `removeFilesFromNeo4j` Uses DETACH DELETE
- **Location:** `loader.ts:490-508`
- **Impact:** Permanently deletes nodes. Temporal mode needs to close them out instead.
- **Fix:** Create `closeOutFiles()` that sets `valid_to` on File nodes and all their contained symbols, rather than deleting them.

### 5. `purgeRepoFromNeo4j` Deletes Everything
- **Location:** `loader.ts:439-456`
- **Impact:** Full purge destroys all history. In temporal mode, a "full re-digest" should close out all existing versions and create new ones, not delete history.
- **Fix:** In temporal mode, skip purge entirely — the diff engine handles transitions. Only purge for explicit "delete all history" operations (user-requested reset).

### 6. MCP Queries Need `valid_to IS NULL` Filter
- **Location:** `packages/mcp-server/src/index.ts` — every Cypher query (~15+ queries)
- **Impact:** Without filter, queries return historical + current nodes mixed together. Results would be duplicated/incorrect.
- **Fix:** Add `WHERE node.valid_to IS NULL` (or temporal range filter) to every MATCH clause. For backward compatibility with repos that don't have temporal fields: use `WHERE node.valid_to IS NULL OR NOT EXISTS(node.valid_to)`.

### 7. Neo4j Identity Keys Need Disambiguation for Temporal Nodes
- **Location:** All `MERGE` statements in loader.ts
- **Impact:** Current identity is `{name, file_path, repo_url}`. With versioning, two versions of the same function exist simultaneously (old with valid_to set, new with valid_to null). MERGE on the same identity key would match the old version.
- **Fix:** For temporal mode, use CREATE instead of MERGE for new versions. MERGE is only used for close-out (matching on identity + `valid_to IS NULL`).

### 8. Missing Supabase Tables
- **Tables needed:** `commits`, `complexity_metrics`, `temporal_digest_jobs`
- **Impact:** No storage for commit metadata or complexity trends
- **Fix:** Create Supabase migration SQL for all three tables.

## Wiring Checklist

### Schema & Infrastructure (Phase 1)
- [ ] Create Supabase migration: `commits` table (id, repo_id, sha, author, author_email, timestamp, message, parent_shas text[])
- [ ] Create Supabase migration: `complexity_metrics` table (id, repo_id, commit_id, file_path, metric_name, metric_value, timestamp)
- [ ] Create Supabase migration: `temporal_digest_jobs` table (id, repo_id, digest_job_id, mode, commits_processed, commits_total, oldest_commit_sha, newest_commit_sha, stats jsonb)
- [ ] Add Neo4j composite indexes: `(valid_from_ts, valid_to_ts)` on Function, Class, TypeDef, Constant, File labels
- [ ] Add Neo4j index on Commit node: `(sha, repo_url)`
- [ ] Verify Neo4j Aura plan supports the projected node count (~50K base + ~50K historical)

### Clone Stage (Phase 2)
- [ ] Add `historyDepth?: number` to `DigestRequest` interface in `digest.ts:13`
- [ ] Modify `cloneRepo()` in `cloner.ts:51` to accept `depth` parameter
- [ ] Change `["--depth", "1"]` to `depth > 0 ? ["--depth", String(depth)] : []`
- [ ] Update `CloneResult` type to include `depth` for downstream use
- [ ] Handle `localPath` mode: use existing .git for history (no clone needed)

### Commit History Ingester (Phase 2)
- [ ] Create `packages/backend/src/pipeline/commit-ingester.ts`
- [ ] Define `CommitMeta` type: `{ sha, author, authorEmail, timestamp, message, parentShas }`
- [ ] Implement `ingestCommitHistory(localPath, repoUrl, depth)` function
- [ ] Use `simple-git` `.log({maxCount: depth})` to extract commits
- [ ] Batch create Commit nodes in Neo4j: `MERGE (c:Commit {sha: $sha, repo_url: $repoUrl})`
- [ ] Create HAS_COMMIT edges: `(Repository)-[:HAS_COMMIT]->(Commit)`
- [ ] Create PARENT_OF edges: `(Commit)-[:PARENT_OF]->(Commit)` using parentShas
- [ ] Batch insert commit metadata to Supabase `commits` table
- [ ] Wire into `runDigest()` — call after clone, before scan
- [ ] Error handling: if git log fails, log warning and continue without history

### Diff Engine (Phase 3)
- [ ] Create `packages/backend/src/pipeline/differ.ts`
- [ ] Define `GraphChangeset` type with created/modified/deleted nodes+edges
- [ ] Define `VersionedNode` type extending ParsedSymbol with temporal fields
- [ ] Define `VersionedEdge` type with source/target identity + properties
- [ ] Implement `fetchCurrentGraphState(repoUrl)` — Cypher query for all nodes/edges WHERE valid_to IS NULL
- [ ] Implement `diffNodes(currentSymbols, previousNodes, identityKey)` — compare by file_path + name
- [ ] Implement `diffEdges(currentEdges, previousEdges, identityKey)` — compare by type + source + target
- [ ] Handle identity matching edge cases: overloaded functions (use signature as tiebreaker), re-exports
- [ ] Return `GraphChangeset` from `diffGraph()` main function
- [ ] Wire into `runDigest()` — call after resolve, before load
- [ ] Unit tests: synthetic graph states with known diffs (add/modify/delete function, add/remove import)

### Temporal Loader (Phase 4)
- [ ] Create `packages/backend/src/pipeline/temporal-loader.ts`
- [ ] Implement `temporalLoadNodes(changeset, commitMeta)`:
  - Close out old versions: `MATCH (n {name, file_path, repo_url}) WHERE n.valid_to IS NULL SET n.valid_to = $sha, n.valid_to_ts = $ts`
  - Insert new versions: `CREATE (n:Label {..., valid_from: $sha, valid_from_ts: $ts, valid_to: null})`
  - Use UNWIND batching (same BATCH_SIZE as existing loader)
- [ ] Implement `temporalLoadEdges(changeset, commitMeta)`:
  - Same close-out + create pattern for IMPORTS, DIRECTLY_IMPORTS, CALLS edges
  - Edge identity: type + source identity + target identity
- [ ] Implement `createIntroducedInEdges(changeset, commitSha)`:
  - `CREATE (node)-[:INTRODUCED_IN {change_type: $type}]->(commit:Commit {sha: $sha})`
- [ ] Implement `closeOutFiles(repoUrl, filePaths, commitMeta)`:
  - Replace `removeFilesFromNeo4j` for temporal mode
  - Sets valid_to on File + all CONTAINS'd symbols
- [ ] Wire into `runDigest()` — replace direct calls to `loadToNeo4j`/`loadSymbolsToNeo4j`/etc. when temporal mode is active
- [ ] Keep existing loader functions unchanged for backward compatibility

### Digest Orchestrator Update (Phase 4)
- [ ] Add `temporal?: boolean` flag to DigestRequest (or infer from historyDepth > 0)
- [ ] Modify `runDigest()` to branch: if temporal, use diff→temporalLoad; else use existing MERGE path
- [ ] For incremental temporal: skip `purgeImportEdges()` and `purgeCallsEdges()` — diff engine handles edge transitions
- [ ] For first temporal digest: diff engine returns all nodes as "created"
- [ ] Update `DigestStats` with temporal-specific fields: `commitsIngested`, `nodesVersioned`, `edgesVersioned`
- [ ] Update `DigestResult` with temporal flag

### Complexity Metrics (Phase 5)
- [ ] Create `packages/backend/src/pipeline/complexity.ts`
- [ ] Implement `computeComplexityMetrics(repoUrl, commitSha, commitTs)`:
  - Query Neo4j for per-file import_count, reverse_import_count, symbol_count
  - Compute coupling_score = import_count + reverse_import_count
  - Compute churn_rate from temporal history (count commits that modified this file)
- [ ] Batch insert to Supabase `complexity_metrics` table
- [ ] Wire into `runDigest()` — call after temporal load
- [ ] Non-fatal: wrap in try/catch, log warning on failure

### Historical Backfill (Phase 5)
- [ ] Create `packages/backend/src/pipeline/backfill.ts`
- [ ] Implement `runHistoricalBackfill(localPath, repoUrl, depth, options)`:
  - Use `simple-git` `.log({maxCount: depth})` to get commit list
  - Iterate oldest → newest
  - Per commit: `git diff --name-only` vs previous, checkout, scan changed files
  - Carry forward unchanged files from previous iteration
  - Parse → Resolve (no SCIP) → Diff → Temporal Load → Complexity Metrics
  - Update progress in `temporal_digest_jobs` table
- [ ] Handle merge commits: treat as single snapshot, diff against immediately prior graph state
- [ ] Handle deleted files: `git diff --name-only --diff-filter=D` to detect
- [ ] Performance: skip commits that only touch non-supported-language files
- [ ] Wire trigger: new API route or flag in DigestRequest (`backfill: true`)
- [ ] Progress reporting: update `temporal_digest_jobs.commits_processed` per commit

### New MCP Temporal Tools (Phase 6)
- [ ] Create `packages/mcp-server/src/temporal-tools.ts` (keep index.ts from growing)
- [ ] Implement `get_symbol_history(name, repo, kind?, since?, max_results?)`:
  - Cypher: MATCH all versions of a symbol, ordered by valid_from_ts DESC
  - Return: version list with signature, change_type, changed_by, commit_message
- [ ] Implement `diff_graph(repo, from_ref, to_ref, scope?)`:
  - Cypher: MATCH nodes where INTRODUCED_IN commit is in the range [from..to]
  - Return: created/modified/deleted nodes and edges with attribution
- [ ] Implement `get_structural_blame(name, repo, kind?)`:
  - Cypher: MATCH earliest INTRODUCED_IN for a symbol
  - Return: commit SHA, author, message, timestamp
- [ ] Implement `get_complexity_trend(repo, path, metric?, since?, granularity?)`:
  - Supabase query on `complexity_metrics` with aggregation
  - Return: time series of metric values
- [ ] Implement `find_when_introduced(repo, target, kind?)`:
  - Cypher: MATCH node/edge with change_type="created", earliest valid_from_ts
  - Return: commit info
- [ ] Implement `find_when_removed(repo, target, kind?)`:
  - Cypher: MATCH node/edge with change_type="deleted"
  - Return: commit info
- [ ] Register all 6 tools with MCP server via `registerTemporalTools(server, getSession, getSupabase)`
- [ ] Call registration function from `index.ts` main setup

### Existing MCP Tool Enrichment (Phase 6)
- [ ] Add `at_commit` (string, optional) parameter to `get_symbol` schema
- [ ] Add `at_commit` parameter to `get_dependencies` schema
- [ ] Add `at_commit` parameter to `trace_imports` schema
- [ ] Add `at_commit` parameter to `get_file` schema
- [ ] Add `at_commit` parameter to `get_repo_structure` schema
- [ ] Create helper function `buildTemporalFilter(atCommit?)`:
  - If no atCommit: `WHERE (node.valid_to IS NULL OR NOT EXISTS(node.valid_to))`
  - If atCommit: resolve to timestamp, `WHERE node.valid_from_ts <= $ts AND (node.valid_to_ts IS NULL OR node.valid_to_ts > $ts)`
- [ ] Apply temporal filter to ALL existing Cypher queries in `index.ts` (audit every MATCH clause)
- [ ] Test: existing queries return same results when no temporal fields exist (backward compat)

## Build Order

### Phase 1: Schema & Infrastructure
**Files:** Supabase migration SQL, Neo4j index creation script
**Dependencies:** None — this is the foundation everything else builds on
**Estimated effort:** 1-2 hours
**Checkpoint:** Verify tables exist, indexes are created, existing queries still work

### Phase 2: Clone + Commit Ingestion
**Files:** `cloner.ts` (modify), `commit-ingester.ts` (new), `digest.ts` (modify)
**Dependencies:** Phase 1 (Supabase `commits` table, Neo4j Commit indexes)
**Estimated effort:** 2-3 hours
**Checkpoint:** Digest creates Commit nodes, git history accessible

### Phase 3: Diff Engine
**Files:** `differ.ts` (new)
**Dependencies:** Phase 1 (temporal fields must exist for previous state queries)
**Estimated effort:** 4-5 hours (highest risk — needs thorough testing)
**Checkpoint:** Unit tests pass for all diff scenarios, identity matching is correct

### Phase 4: Temporal Loader + Orchestrator
**Files:** `temporal-loader.ts` (new), `digest.ts` (modify), `loader.ts` (keep unchanged)
**Dependencies:** Phase 3 (Diff Engine provides changeset), Phase 2 (Commit nodes exist)
**Estimated effort:** 4-5 hours
**Checkpoint:** Incremental temporal digest creates versioned nodes, old versions closed out

### Phase 5: Complexity Metrics + Historical Backfill
**Files:** `complexity.ts` (new), `backfill.ts` (new)
**Dependencies:** Phase 4 (temporal loader), Phase 2 (commit ingestion)
**Estimated effort:** 4-5 hours
**Checkpoint:** Backfill populates temporal history, complexity metrics queryable

### Phase 6: MCP Tools
**Files:** `temporal-tools.ts` (new in mcp-server), `index.ts` (modify in mcp-server)
**Dependencies:** Phase 4 (temporal data must exist in graph), Phase 5 (complexity metrics)
**Estimated effort:** 4-5 hours
**Checkpoint:** All 6 new tools return correct data, existing tools work with and without at_commit

### Total: ~20-25 hours across 6 phases
