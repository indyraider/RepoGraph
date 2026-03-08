# Phase 6 Forward Audit: MCP Tools (FINAL PHASE)
**Date:** 2026-03-07
**Plan:** temporal-graph-plan-2026-03-07.md
**Phase:** 6 of 6 (Final)
**Files audited:**
- `packages/mcp-server/src/temporal-tools.ts` (NEW)
- `packages/mcp-server/src/index.ts` (MODIFIED)
- All earlier-phase files for overall completeness

---

## 1. Interface Extraction: temporal-tools.ts

### registerTemporalTools() Signature

```ts
export function registerTemporalTools(
  server: McpServer,
  getSession: GetSessionFn,
  getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void
```

Called from `index.ts:1040`:
```ts
registerTemporalTools(server, getSession, getSupabase, SCOPED_REPO);
```

**Match vs plan:** Plan specifies `registerTemporalTools(server, getSession, getSupabase)`. Implementation adds `scopedRepo` parameter (consistent with how existing tools use `SCOPED_REPO`). This is a sensible addition.

### Tool 1: get_symbol_history
| Aspect | Plan | Actual |
|--------|------|--------|
| Name | `get_symbol_history` | `get_symbol_history` |
| Params | `name, repo, kind?, since?, max_results?` | `name, repo?, kind?, max_results?` |
| Missing | — | `since?` parameter not implemented |
| Return | Version list with signature, change_type, changed_by, commit_message | Markdown-formatted version list with those fields |

### Tool 2: diff_graph
| Aspect | Plan | Actual |
|--------|------|--------|
| Name | `diff_graph` | `diff_graph` |
| Params | `repo, from_ref, to_ref, scope?` | `repo?, from_ref, to_ref, scope?` |
| Return | Created/modified/deleted nodes+edges with attribution | Markdown with +/~/- prefixed lines |

### Tool 3: get_structural_blame
| Aspect | Plan | Actual |
|--------|------|--------|
| Name | `get_structural_blame` | `get_structural_blame` |
| Params | `name, repo, kind?` | `name, repo?, kind?` |
| Return | Commit SHA, author, message, timestamp | Markdown block with those fields |

### Tool 4: get_complexity_trend
| Aspect | Plan | Actual |
|--------|------|--------|
| Name | `get_complexity_trend` | `get_complexity_trend` |
| Params | `repo, path, metric?, since?, granularity?` | `repo?, path, metric?, max_results?` |
| Missing | — | `since?` and `granularity?` parameters not implemented |
| Added | — | `max_results?` (default 20) replaces time-based filtering |
| Return | Time series of metric values | Markdown table with commit/metric/value/date |

### Tool 5: find_when_introduced
| Aspect | Plan | Actual |
|--------|------|--------|
| Name | `find_when_introduced` | `find_when_introduced` |
| Params | `repo, target, kind?` | `name, repo?, kind?` |
| Renamed | `target` -> `name` | More consistent with other tool params |
| Return | Commit info | Formatted text block |

### Tool 6: find_when_removed
| Aspect | Plan | Actual |
|--------|------|--------|
| Name | `find_when_removed` | `find_when_removed` |
| Params | `repo, target, kind?` | `name, repo?, kind?` |
| Renamed | `target` -> `name` | Same rename as find_when_introduced |
| Return | Commit info | Formatted text block (returns up to 5 removals) |

### Helper Function
- `toNum(val)` — safely converts Neo4j integers to JS numbers. Private to the module.

---

## 2. Interface Extraction: index.ts Modifications

### Temporal Filter on Existing Queries
The `valid_to IS NULL OR NOT EXISTS(valid_to)` filter was applied extensively across all existing Cypher queries. Grep found **35+ occurrences** across tools:
- `get_symbol`: Filters on sym, callers, imports, direct imports
- `get_type_info`: Filters on sym, callers, call edges
- `get_dependencies`: Filters on IMPORTS edges
- `trace_imports`: Filters on relationships in path traversal
- `get_repo_structure`: Filters on IMPORTS edges
- `search_code`: No Neo4j queries (Supabase full-text search) — N/A

The filter pattern used is backward-compatible: `WHERE (node.valid_to IS NULL OR NOT EXISTS(node.valid_to))`, which matches both temporal nodes (valid_to = null for current) and non-temporal nodes (field doesn't exist).

### registerTemporalTools Registration
- Imported at line 10: `import { registerTemporalTools } from "./temporal-tools.js";`
- Called at line 1040: `registerTemporalTools(server, getSession, getSupabase, SCOPED_REPO);`

---

## 3. Mismatch Detection: Phase 6 vs Plan

### MISSING: `at_commit` parameter on existing tools
**Severity: Significant gap**

The plan specifies adding `at_commit` (string, optional) to 5 existing tools:
- [ ] `get_symbol` — NOT implemented
- [ ] `get_dependencies` — NOT implemented
- [ ] `trace_imports` — NOT implemented
- [ ] `get_file` — NOT implemented
- [ ] `get_repo_structure` — NOT implemented

None of these tools have an `at_commit` parameter. The temporal filters applied use only `valid_to IS NULL` (current state only). There is no way for a user to query the graph "as of commit X" via existing tools.

### MISSING: `buildTemporalFilter()` helper function
**Severity: Moderate gap (blocks at_commit)**

The plan specifies a helper:
```
buildTemporalFilter(atCommit?):
  If no atCommit: WHERE (node.valid_to IS NULL OR NOT EXISTS(node.valid_to))
  If atCommit: resolve to timestamp, WHERE node.valid_from_ts <= $ts AND (node.valid_to_ts IS NULL OR node.valid_to_ts > $ts)
```
This was NOT implemented. The `valid_to IS NULL` filters are hardcoded inline. Without this helper, `at_commit` support would require modifying every query individually.

### MISSING: `since?` parameter on get_symbol_history and get_complexity_trend
**Severity: Minor**

Both tools omit the `since?` param from the plan. Users cannot filter to recent history only. The `max_results` param partially compensates by limiting output.

### MISSING: `granularity?` parameter on get_complexity_trend
**Severity: Minor**

The plan specified a `granularity` parameter for time-based aggregation. Not implemented. Raw data points are returned instead.

### DEVIATION: `target` renamed to `name` in find_when_introduced / find_when_removed
**Severity: Neutral (improvement)**

Renaming `target` to `name` is consistent with all other tools that use `name` for symbol lookup.

---

## 4. Overall Completeness: All 6 Phases

### Phase 1: Schema & Infrastructure
| Checklist Item | Status | Notes |
|---|---|---|
| Supabase `commits` table | DONE | `supabase-temporal-migration.sql` |
| Supabase `complexity_metrics` table | DONE | Same file |
| Supabase `temporal_digest_jobs` table | DONE | Same file |
| Neo4j composite indexes on temporal fields | DONE | `neo4j.ts` — indexes on `(valid_from_ts, valid_to_ts)` for Function, Class, TypeDef, Constant, File |
| Neo4j index on Commit (sha, repo_url) | DONE | `neo4j.ts` — three indexes: sha, repo_url, composite |

### Phase 2: Clone + Commit Ingestion
| Checklist Item | Status | Notes |
|---|---|---|
| `historyDepth?` on DigestRequest | DONE | `digest.ts:29` |
| `cloneRepo()` accepts depth parameter | DONE | `cloner.ts:54` — `depth: number = 1` |
| Dynamic `--depth` in clone args | DONE | `cloner.ts:62` — conditional depth handling |
| `commit-ingester.ts` created | DONE | Full implementation with CommitMeta type |
| `ingestCommitHistory()` function | DONE | Creates Commit nodes, HAS_COMMIT edges, PARENT_OF edges |
| Supabase commits upsert | DONE | With `onConflict: "repo_id,sha"` |
| Wired into `runDigest()` | DONE | `digest.ts:268-278` — called after clone, before scan |
| Error handling: non-fatal | DONE | Try/catch with warning, continues digest |

### Phase 3: Diff Engine
| Checklist Item | Status | Notes |
|---|---|---|
| `differ.ts` created | DONE | Full implementation |
| `GraphChangeset` type | DONE | With nodes/edges/stats, but structured as flat arrays with `changeType` field rather than plan's `created/modified/deleted` sub-objects |
| `GraphNodeSnapshot` type | DONE | Maps to plan's `VersionedNode` concept |
| `GraphEdgeSnapshot` type | DONE | Maps to plan's `VersionedEdge` concept |
| `fetchPreviousGraphState()` | DONE | Queries nodes, IMPORTS edges, CALLS edges with `valid_to IS NULL` filter |
| `diffNodes()` logic | DONE | Inline in `diffGraph()` rather than separate function |
| `diffEdges()` logic | DONE | Handles both IMPORTS and CALLS edges |
| Identity matching | DONE | `filePath::name` for symbols, edge-type-specific keys |
| Wired into `runDigest()` | DONE | `digest.ts:395` |

### Phase 4: Temporal Loader + Orchestrator
| Checklist Item | Status | Notes |
|---|---|---|
| `temporal-loader.ts` created | DONE | Full implementation |
| `temporalLoadNodes()` (create) | DONE | `createNodes()` — batched UNWIND with temporal fields |
| `temporalLoadNodes()` (modify) | DONE | `modifyNodes()` — close-out + create (per-node, not batched) |
| `temporalLoadNodes()` (delete) | DONE | `closeOutNodes()` — batched SET valid_to |
| `temporalLoadEdges()` | DONE | `createEdges()`, `modifyEdges()`, `closeOutEdges()` |
| `createIntroducedInEdges()` | DONE | Links created/modified/deleted nodes to Commit |
| `closeOutFiles()` | NOT DONE | Plan item; not implemented as separate function. File nodes use classic MERGE (non-versioned). |
| Digest orchestrator branching | DONE | `digest.ts:385-433` — `useTemporal = !!headCommit` |
| Skip purgeImportEdges in temporal mode | DONE | Temporal path does not call purge functions |
| DigestStats temporal fields | PARTIAL | `TemporalLoadResult` stored in job stats as `temporal` sub-object, but `DigestStats` type not extended with `commitsIngested`, `nodesVersioned`, `edgesVersioned` |

### Phase 5: Complexity Metrics + Historical Backfill
| Checklist Item | Status | Notes |
|---|---|---|
| `complexity.ts` created | DONE | Computes import_count, reverse_import_count, symbol_count, coupling_score |
| `computeComplexityMetrics()` | DONE | Queries Neo4j, writes to Supabase |
| Temporal-aware queries | DONE | Uses `valid_to IS NULL OR NOT EXISTS(valid_to)` |
| Non-fatal wrapper | DONE | `digest.ts:422-428` — try/catch with warning |
| `backfill.ts` created | DONE | Full implementation |
| `runHistoricalBackfill()` | DONE | Iterates oldest-to-newest, checkout per commit |
| Parse -> Resolve -> Diff -> Temporal Load per commit | DONE | SCIP skipped per-commit (as planned) |
| Progress in `temporal_digest_jobs` | DONE | Updates `commits_processed` per commit |
| Merge commit handling | NOT EXPLICIT | Treats all commits identically (sequential diff) |
| Skip non-language commits | NOT DONE | Processes all commits regardless |
| Backfill trigger/API route | NOT DONE | Function exists but no API route or DigestRequest flag |
| `churn_rate` metric | NOT DONE | Plan mentions it; only import_count, reverse_import_count, symbol_count, coupling_score computed |

### Phase 6: MCP Tools
| Checklist Item | Status | Notes |
|---|---|---|
| `temporal-tools.ts` created | DONE | 6 tools registered |
| `get_symbol_history` | DONE | Missing `since?` param |
| `diff_graph` | DONE | Full implementation |
| `get_structural_blame` | DONE | Full implementation |
| `get_complexity_trend` | DONE | Missing `since?` and `granularity?` params |
| `find_when_introduced` | DONE | `target` renamed to `name` |
| `find_when_removed` | DONE | `target` renamed to `name` |
| Registration in index.ts | DONE | Line 1040 |
| `at_commit` on `get_symbol` | NOT DONE | |
| `at_commit` on `get_dependencies` | NOT DONE | |
| `at_commit` on `trace_imports` | NOT DONE | |
| `at_commit` on `get_file` | NOT DONE | |
| `at_commit` on `get_repo_structure` | NOT DONE | |
| `buildTemporalFilter()` helper | NOT DONE | |
| Temporal filters on all existing queries | DONE | `valid_to IS NULL` applied inline |

---

## 5. Summary of Gaps

### Significant (functional gaps)
1. **`at_commit` parameter missing on all 5 existing tools.** Users cannot query the graph at a historical point in time via `get_symbol`, `get_dependencies`, `trace_imports`, `get_file`, or `get_repo_structure`. The temporal data exists in Neo4j but is only queryable via the 6 new temporal-specific tools.
2. **`buildTemporalFilter()` helper not implemented.** Temporal filters are hardcoded inline as `valid_to IS NULL`. This makes adding `at_commit` support a larger diff than planned.

### Moderate (partially functional)
3. **`closeOutFiles()` not implemented as separate function.** File nodes are loaded via classic MERGE (not versioned). If a file is deleted and re-created, the File node history is lost. Symbol versioning still works since symbols carry their own temporal fields.
4. **Backfill has no API trigger.** `runHistoricalBackfill()` exists but is not wired to any API route or DigestRequest flag. Must be called programmatically.
5. **`churn_rate` metric not computed.** Plan mentions it as a complexity metric but only 4 of 5 metrics are implemented.

### Minor (polish)
6. **`since?` parameter missing** on `get_symbol_history` and `get_complexity_trend`. Users must rely on `max_results` to limit output.
7. **`granularity?` parameter missing** on `get_complexity_trend`. Raw data points returned without aggregation.
8. **`DigestStats` not extended** with `commitsIngested`, `nodesVersioned`, `edgesVersioned` fields. Temporal stats stored in a separate `temporal` sub-object of job stats.
9. **Performance optimization for backfill not done:** skipping commits that only touch non-supported-language files.

### Deferred Items (documented in earlier checkpoints)
- File node versioning (File nodes use classic MERGE)
- Backfill API route
- These were noted in Phase 4/5 audits as acceptable deferrals

---

## 6. Verdict

**Phase 6 is substantially complete.** All 6 temporal tools are implemented and registered. All existing Cypher queries have backward-compatible temporal filters. The `registerTemporalTools()` function signature and wiring are correct.

**The primary gap is `at_commit` support on existing tools**, which the plan lists as a Phase 6 deliverable. This means users can query temporal history through the 6 new tools but cannot "time-travel" with existing tools like `get_symbol` or `trace_imports`. The infrastructure for this (temporal indexes, `valid_from_ts`/`valid_to_ts` fields, INTRODUCED_IN edges) is fully in place — what's missing is the query-level parameter plumbing and the `buildTemporalFilter()` helper.

**Across all 6 phases**, the core temporal pipeline is functional end-to-end: clone with history, ingest commits, diff graph, temporal load with versioning, complexity metrics, historical backfill, and 6 temporal MCP tools. The build delivers approximately 85-90% of the plan's scope.
