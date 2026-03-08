# Brainstorm: Temporal Graph (Code Evolution Over Time)
**Created:** 2026-03-07
**Status:** Draft
**PRD:** repograph-temporal-graph-prd.md

## Vision

Extend RepoGraph from a point-in-time code snapshot to a versioned history of the structural graph across commits. Every node and edge carries `valid_from`/`valid_to` temporal fields keyed to commit SHAs and timestamps. This enables Claude Code to answer questions like "when did this function's signature change?", "who introduced this dependency?", and "how has this module's complexity grown?" — structural blame, not line-level blame.

The temporal graph is also the strongest retention mechanic in the product — the graph accumulates value the longer someone uses it, creating an asymmetry that cannot be replicated by switching tools.

## Existing Context

**via RepoGraph:** The current pipeline lives in `packages/backend/src/pipeline/` with 18 files:

| Stage | File | Key Function | What It Does |
|-------|------|--------------|--------------|
| Clone | `cloner.ts` | `cloneRepo()` | `--depth 1` shallow clone, returns `localPath` + `commitSha` |
| Scan | `scanner.ts` | `scanRepo()` | Walks filesystem, returns `ScannedFile[]` with `contentHash` |
| Parse | `parser.ts` | `parseFile()` | Extracts symbols, imports, exports per file |
| SCIP | `scip/index.ts` | `runScipStage()` | Type analysis — resolved signatures, CALLS edges |
| Resolve | `resolver.ts` | `resolveImports()` | Resolves import paths, builds `DirectlyImportsEdge[]` |
| Deps | `deps/indexer.ts` | `indexDependencies()` | Reads lockfiles, indexes upstream packages |
| Load | `loader.ts` | `loadToNeo4j()`, `loadSymbolsToNeo4j()`, etc. | MERGE/upsert nodes+edges into Neo4j, upsert file contents to Supabase |

**Orchestrator:** `runDigest()` in `digest.ts:173` (~340 lines) runs the full pipeline. Called by `SyncManager.executeDigest()` in `sync/manager.ts`.

**Incremental digest:** Already exists. `diffFiles()` compares `content_hash` from Supabase `file_contents` to detect changed/deleted files. Changed files are re-parsed, their Neo4j nodes are removed (`removeFilesFromNeo4j`) and re-inserted. Import/CALLS edges are purged globally and reloaded.

**Neo4j schema (current):**
- Nodes: Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport
- Edges: CONTAINS_FILE, CONTAINS, IMPORTS, DIRECTLY_IMPORTS, EXPORTS, CALLS, EXTENDS, IMPLEMENTS, DEPENDS_ON, PROVIDES
- Identity keys: `repo_url` + `file_path` + `name` (no temporal fields)
- Load pattern: `MERGE` on identity keys → overwrites properties in place

**Supabase tables (current):**
- `repositories` — url, name, branch, status, commit_sha, last_digest_at
- `file_contents` — repo_id, file_path, content, content_hash, language, size_bytes
- `digest_jobs` — repo_id, status, stage, stats, error_log
- `runtime_logs` — timestamps, levels, messages, stack traces
- `deployments` — platform, status, branch, commit_sha

**MCP server:** `packages/mcp-server/src/index.ts` (37KB) — all 10 code graph tools defined in a single file. Queries Neo4j via Cypher and Supabase via client.

## Components Identified

### 1. Clone Stage Modifier (configurable depth)
- **Responsibility**: Replace `--depth 1` with configurable clone depth to access commit history
- **Upstream (receives from)**: `DigestRequest` with new `historyDepth` option
- **Downstream (sends to)**: Commit metadata (SHA, author, timestamp, message, parents) to new Commit ingestion component
- **External dependencies**: `simple-git` (already a dependency)
- **Hands test**: PASS — `simple-git` supports `git log` and full/partial clones. Already used in `cloner.ts`.

### 2. Commit History Ingester
- **Responsibility**: Walk `git log` output and create Commit nodes in Neo4j + rows in Supabase `commits` table
- **Upstream (receives from)**: Cloned repo path with history, `simple-git` instance
- **Downstream (sends to)**: Commit nodes → Neo4j (HAS_COMMIT, PARENT_OF edges); commit metadata → Supabase `commits` table
- **External dependencies**: Neo4j session (`getSession()`), Supabase client (`getSupabase()`)
- **Hands test**: PASS — both Neo4j and Supabase clients exist and are used throughout the loader.

### 3. Diff Engine
- **Responsibility**: Compare the current Resolve-stage output against the previously stored graph state, producing a changeset of created/modified/deleted nodes and edges
- **Upstream (receives from)**: Current parse+resolve output (symbols, imports, exports); previous graph state from Neo4j (filtered to `valid_to = null`)
- **Downstream (sends to)**: Changeset → Temporal Load stage
- **External dependencies**: Neo4j read queries to fetch current graph state
- **Hands test**: FAIL — **This is entirely new code.** The existing `diffFiles()` only compares file-level content hashes. The diff engine needs to compare at the symbol/edge level using identity keys (file_path + name). No existing code does structural diffing. Must be built from scratch.

### 4. Temporal Load Stage
- **Responsibility**: Instead of MERGE/overwrite, close out old versions (`valid_to = commit_sha`) and insert new versions (`valid_from = commit_sha`) for changed nodes/edges. Write `INTRODUCED_IN` edges.
- **Upstream (receives from)**: Changeset from Diff Engine; commit metadata
- **Downstream (sends to)**: Neo4j graph with temporal annotations
- **External dependencies**: Neo4j session
- **Hands test**: FAIL — **Current loader overwrites.** `loadToNeo4j()` uses `MERGE ... SET` which updates in place. `loadSymbolsToNeo4j()` similarly uses `MERGE`. The temporal loader needs a fundamentally different write pattern: close-out + insert instead of upsert. New code required, but it follows the same batching pattern as the existing loader.

### 5. Schema Migration (Neo4j + Supabase)
- **Responsibility**: Add temporal properties to all versioned node labels and edge types in Neo4j. Create new Supabase tables (`commits`, `complexity_metrics`, `temporal_digest_jobs`). Add composite indexes on temporal fields.
- **Upstream (receives from)**: N/A — runs once as a migration
- **Downstream (sends to)**: Updated schema available to all other components
- **External dependencies**: Neo4j admin access, Supabase migration tooling
- **Hands test**: PASS — existing codebase uses both Neo4j and Supabase. Migration is a one-time operation. Need to decide: is the Neo4j "migration" just adding properties to new writes, or do we need to backfill existing nodes with `valid_from` set to their last digest commit?

### 6. Historical Backfill Mode
- **Responsibility**: Walk backward through git history, check out each commit's tree, run Scan → Parse → Resolve → Diff → Load for each commit
- **Upstream (receives from)**: Cloned repo with full history; configurable depth/date cutoff
- **Downstream (sends to)**: Temporal graph progressively enriched per commit
- **External dependencies**: `simple-git` for checkout per commit; full pipeline for each commit
- **Hands test**: FAIL — **Performance-critical and complex.** Must use `git diff --name-only` to skip unchanged files per commit. Must handle the pipeline running N times (potentially 100+ commits). No existing code for iterating commits. The pipeline is designed to run once per digest, not in a loop. Needs careful orchestration to avoid re-cloning, re-initializing, etc. Most risky component.

### 7. Complexity Metrics Computer
- **Responsibility**: At Load time, compute per-file and per-repo metrics (import_count, symbol_count, coupling_score, churn_rate) and store in Supabase
- **Upstream (receives from)**: Graph state at each commit (from Neo4j or from in-memory resolve output)
- **Downstream (sends to)**: Supabase `complexity_metrics` table
- **External dependencies**: Supabase client
- **Hands test**: PASS — straightforward computation + Supabase insert. Data sources all exist.

### 8. New MCP Temporal Tools (6 tools)
- **Responsibility**: `get_symbol_history`, `diff_graph`, `get_structural_blame`, `get_complexity_trend`, `find_when_introduced`, `find_when_removed`
- **Upstream (receives from)**: Temporal graph in Neo4j; complexity metrics in Supabase
- **Downstream (sends to)**: Claude Code via MCP protocol
- **External dependencies**: Neo4j session, Supabase client, MCP SDK (already used)
- **Hands test**: PASS — all follow the same pattern as existing MCP tools. Cypher queries filtered by temporal fields. The MCP server in `index.ts` already defines 10+ tools.

### 9. Existing MCP Tool Enrichment (`at_commit` parameter)
- **Responsibility**: Add optional `at_commit`/`at_date` parameter to `get_symbol`, `get_dependencies`, `trace_imports`, `get_file`, `get_repo_structure`
- **Upstream (receives from)**: User query with optional temporal parameter
- **Downstream (sends to)**: Filtered query results showing graph state at that point in time
- **External dependencies**: Same as existing tools
- **Hands test**: PASS — requires modifying Cypher queries to add `WHERE valid_from_ts <= $ts AND (valid_to_ts IS NULL OR valid_to_ts > $ts)` filter. Straightforward if temporal fields exist on nodes.

## Rough Dependency Map

```
DigestRequest (with historyDepth)
    │
    ▼
[1] Clone Stage Modifier ──► configurable depth clone
    │
    ├──► [2] Commit History Ingester ──► Commit nodes in Neo4j + Supabase
    │
    ▼
[existing] Scan → Parse → SCIP → Resolve
    │
    ▼
[3] Diff Engine ◄── previous graph state (Neo4j, valid_to=null)
    │
    ▼
[4] Temporal Load Stage ──► versioned nodes/edges in Neo4j
    │                        INTRODUCED_IN edges
    │
    ├──► [7] Complexity Metrics ──► Supabase complexity_metrics
    │
    ▼
[6] Historical Backfill (loops [Scan→Parse→Resolve→Diff→Load] per commit)

[5] Schema Migration ──► prerequisite for everything above

[8] New MCP Tools ──► queries temporal graph
[9] Enriched MCP Tools ──► adds at_commit to existing queries
```

## Open Questions

1. **Neo4j migration strategy:** Do we backfill existing nodes with `valid_from` = last digest commit? Or only apply temporal fields to new writes going forward? Backfill is simpler for query consistency but requires a migration script.

2. **Clone depth default for incremental digests:** The PRD says historical backfill is opt-in. But even for regular incremental digests, should we clone with depth > 1 so we can record the commit metadata for the current digest? Depth 1 gives us HEAD only. We'd need at least depth 2 to get the parent commit for diff context.

3. **How does this interact with watcher/local-path mode?** The current `runDigest` supports `req.localPath` for watcher-triggered digests. These skip cloning entirely. How does the temporal graph handle local-path digests — can it access `git log` from the local repo?

4. **SCIP stage per historical commit:** The historical backfill loops Scan → Parse → Resolve per commit. Does it also run SCIP? SCIP is expensive (spawns `scip-typescript`). Running it 100 times would dominate backfill time. Could skip SCIP for historical commits and only run it for HEAD.

5. **Import edge strategy:** Currently, incremental digests purge ALL import edges and reload them (`purgeImportEdges` + `loadImportsToNeo4j`). With temporal versioning, edges need individual close-out/create. This is a significant change to the load pattern for edges.

6. **Storage: Neo4j free tier limits?** If using Neo4j Aura free tier, there are node/relationship limits. 100 commits of history on a 5K-file repo could exceed free tier limits. Need to validate.

## Risks and Concerns

1. **Historical backfill performance is the biggest risk.** Running the full pipeline 100 times is expensive even with skip-unchanged optimization. The SCIP stage alone takes 10-30 seconds per run. Need to decide: skip SCIP for historical commits, or accept 30-50 minute backfill times.

2. **The Diff Engine is net-new, complex code.** Identity matching (file_path + name) has edge cases: overloaded functions, re-exported symbols, barrel files. Needs thorough unit testing. This is the critical-path module.

3. **Loader rewrite scope.** The temporal load pattern (close-out + insert) is fundamentally different from the current MERGE pattern. This touches `loadToNeo4j`, `loadSymbolsToNeo4j`, `loadImportsToNeo4j`, `loadCallsToNeo4j`, and `loadDependenciesToNeo4j`. Not a small change.

4. **MCP query performance with temporal filtering.** Every existing Cypher query in the MCP server (37KB file) currently assumes `valid_to = null` (current state). Adding temporal filtering to all queries requires auditing every single query. Without proper indexes, temporal queries could be slow.

5. **The shallow clone is deeply embedded.** `cloneRepo()` is called by `runDigest()` which is called by `SyncManager.executeDigest()`. Changing clone depth affects disk usage, clone time, and potentially CI/CD workflows. The watcher path skips cloning entirely and reads from the local repo — this is actually the easiest path for temporal data since the full git history is already available.

6. **Existing non-temporal queries must not degrade.** All current MCP tools query current state. If we add temporal fields, every query needs `WHERE valid_to IS NULL` to maintain current behavior. Missing this filter on even one query breaks the tool.
