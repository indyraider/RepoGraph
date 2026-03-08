# Phase 5 Forward Check: Complexity Metrics + Historical Backfill -> Phase 6 (MCP Tools)

**Date:** 2026-03-07
**Phase completed:** 5 (Complexity Metrics + Historical Backfill)
**Next phase:** 6 (MCP Tools)

---

## 1. Interface Extraction (What Phase 5 Built)

### `computeComplexityMetrics()` — `complexity.ts:31-36`
```typescript
export async function computeComplexityMetrics(
  repoUrl: string,
  repoId: string,
  commitSha: string,
  commitTs: string       // ISO 8601 string
): Promise<ComplexityResult>

interface ComplexityResult {
  metricsComputed: number;
  filesAnalyzed: number;
}
```

**Metric names written to Supabase `complexity_metrics`:**
- `import_count` — files this file imports from
- `reverse_import_count` — files that import this file
- `symbol_count` — number of symbols in the file
- `coupling_score` — `import_count + reverse_import_count`

**Supabase columns written:** `repo_id`, `commit_sha`, `file_path`, `metric_name`, `metric_value`, `timestamp`

### `runHistoricalBackfill()` — `backfill.ts:42-48`
```typescript
export async function runHistoricalBackfill(
  localPath: string,
  repoUrl: string,
  repoId: string,
  repoName: string,
  branch: string,
  options: BackfillOptions = {}
): Promise<BackfillResult>

interface BackfillOptions {
  maxCommits?: number;    // default: 50
  skipMetrics?: boolean;  // default: false
}

interface BackfillResult {
  commitsProcessed: number;
  commitsTotal: number;
  durationMs: number;
  errors: string[];
}
```

---

## 2. Mismatch Detection for Phase 6

### 2.1 `get_complexity_trend` tool

**Plan says:** queries Supabase `complexity_metrics` by `repo_id`, `file_path`, `metric_name`, ordered by `timestamp`.

**What Phase 5 writes:**
- Column `repo_id` -- MATCH. Uses Supabase UUID.
- Column `file_path` -- MATCH
- Column `metric_name` -- MATCH. Values: `import_count`, `reverse_import_count`, `symbol_count`, `coupling_score`
- Column `timestamp` -- MATCH. Stored as ISO 8601 timestamptz.
- Column `commit_sha` -- available for additional filtering if needed.
- Column `metric_value` -- REAL, stores the numeric value.

**MISMATCH: `churn_rate` metric is MISSING.**
The plan (Phase 5 checklist item) says: "Compute churn_rate from temporal history (count commits that modified this file)." The Supabase migration schema comment also lists `churn_rate` as an expected metric_name. However, `complexity.ts` does NOT compute or write `churn_rate`. Only four metrics are written: `import_count`, `reverse_import_count`, `symbol_count`, `coupling_score`.

**Impact on Phase 6:** The `get_complexity_trend` tool could accept `churn_rate` as a metric parameter and return empty results. Not a hard blocker -- the tool will simply return no data for that metric -- but it means the PRD's churn rate feature is incomplete.

**Recommendation:** Either:
(a) Add `churn_rate` computation to `computeComplexityMetrics()` before Phase 6 (requires querying temporal history in Neo4j to count commits touching each file), or
(b) Document `churn_rate` as unsupported and restrict the MCP tool's `metric` parameter to the four implemented metrics.

**Table/index readiness:** The `complexity_metrics` table has indexes on `(repo_id, file_path)`, `(repo_id, timestamp DESC)`, and `(repo_id, metric_name, file_path)`. These are sufficient for `get_complexity_trend` queries with `since` and `granularity` parameters.

### 2.2 `get_symbol_history` tool

**Plan says:** queries Neo4j for temporal versions of symbols, returning `f.signature`, `f.valid_from`, `f.valid_from_ts`, `f.valid_to`, `f.valid_to_ts`, `f.change_type`, `f.changed_by`, `c.message`.

**What temporal-loader writes (per `temporal-loader.ts`):**
- `valid_from` (commit SHA) -- MATCH
- `valid_from_ts` (datetime) -- MATCH (stored via `datetime()` cast)
- `valid_to` (commit SHA, set on close-out) -- MATCH
- `valid_to_ts` (datetime, set on close-out) -- MATCH
- `change_type` ("created"/"modified"/"deleted") -- MATCH
- `changed_by` (author name) -- MATCH
- `commit_message` (commit message text) -- MATCH

**NO MISMATCHES.** All properties that `get_symbol_history` needs are written by temporal-loader. The INTRODUCED_IN edges also exist and carry `change_type`.

### 2.3 `diff_graph` tool

**Plan says:** queries INTRODUCED_IN edges to find nodes introduced in a commit range.

**What temporal-loader writes (`createIntroducedInEdges`):**
- `(node)-[:INTRODUCED_IN {change_type: "created"|"modified"|"deleted"}]->(commit:Commit)`
- For created/modified nodes: matches `n.valid_from = $sha`
- For deleted nodes: matches `n.valid_to = $sha`

**NO MISMATCHES.** INTRODUCED_IN edges are created for all three change types. The MCP tool can query by commit SHA range using `(c:Commit)` nodes and their timestamps.

**Minor note:** The `diff_graph` tool will need to resolve `from_ref`/`to_ref` to commit timestamps for range queries. Commit nodes store `timestamp` as a Neo4j `datetime`, which supports range comparisons.

### 2.4 `at_commit` enrichment (existing tool modification)

**Plan says:** existing tools need `buildTemporalFilter(atCommit?)` helper. When `at_commit` is provided, resolve to timestamp, filter `WHERE valid_from_ts <= $ts AND (valid_to_ts IS NULL OR valid_to_ts > $ts)`.

**Temporal index readiness (from Phase 1):**
- Composite indexes on `(valid_from_ts, valid_to_ts)` should exist on Function, Class, TypeDef, Constant labels.
- Commit node index on `(sha, repo_url)` exists (needed to resolve SHA to timestamp).

**MISMATCH: Existing MCP queries have NO temporal filter.**
Every MATCH clause in `index.ts` (all ~15+ queries) currently returns ALL nodes including historical versions. Once temporal-loader creates versioned nodes, the existing tools will return duplicates -- multiple versions of the same symbol.

**Impact on Phase 6:** This is addressed by Phase 6 itself (the "Existing MCP Tool Enrichment" task), but the builder must be aware that deploying Phase 5 without Phase 6 will degrade existing tool results for repos that have been temporally digested. The backward-compat guard `WHERE node.valid_to IS NULL OR NOT EXISTS(node.valid_to)` must be added to ALL existing queries as part of Phase 6.

**Current queries requiring temporal filter (audit of `index.ts`):**
1. `get_repo_structure` -- line 217: `MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File)` -- Files don't have temporal fields (temporal-loader doesn't version Files), so this is safe.
2. `get_symbol` -- lines 304, 352: `MATCH (f:File)-[:CONTAINS]->(sym)` -- NEEDS filter on `sym.valid_to`
3. `get_symbol` (fuzzy) -- lines 351, 372: same pattern -- NEEDS filter
4. `get_dependencies` -- lines 499, 524, 542, 561, 578: MATCH on IMPORTS and CALLS edges -- NEEDS filter on edge `valid_to`
5. `trace_imports` -- lines 629, 644, 651: IMPORTS/DIRECTLY_IMPORTS traversal -- NEEDS filter on edge `valid_to`
6. `get_type_info` -- line 835: `MATCH (f:File)-[:CONTAINS]->(sym)` -- NEEDS filter
7. `query_graph` -- raw Cypher, no auto-filter possible (user responsibility)

### 2.5 Backfill trigger mechanism

**Plan says:** "Wire trigger: new API route or flag in DigestRequest (`backfill: true`)."

**MISMATCH: No backfill trigger exists.**
- `runHistoricalBackfill()` is defined in `backfill.ts` but is NOT wired to any API route or called from `digest.ts`.
- `DigestRequest` in `digest.ts` has `historyDepth` but no `backfill` flag.
- The existing routes in `routes.ts` include `POST /digest` but it calls `runDigest()`, not `runHistoricalBackfill()`.

**Impact on Phase 6:** The MCP temporal tools can still work without a backfill trigger (they query whatever temporal data exists in the graph). However, the backfill feature is currently unreachable by users, meaning repos will only have temporal data from the point they first ran a temporal digest onward.

**Recommendation:** Add one of:
(a) A `backfill?: boolean` flag on `DigestRequest` + branching logic in `runDigest()` or `POST /digest` route, or
(b) A new `POST /backfill` API route that calls `runHistoricalBackfill()` directly, or
(c) A new MCP tool `trigger_backfill` (though MCP tools are read-only by convention).

This should be addressed before or during Phase 6.

---

## 3. Dependency Readiness for Phase 6

### 3.1 What the MCP server needs from the backend pipeline

Phase 6 does NOT need to import backend pipeline code. The MCP server queries Neo4j and Supabase directly -- it reads the data that the pipeline wrote. The temporal tools need:

- **Neo4j read access** -- for `get_symbol_history`, `diff_graph`, `get_structural_blame`, `find_when_introduced`, `find_when_removed`, and the `at_commit` filter on existing tools.
- **Supabase read access** -- for `get_complexity_trend`.

No new pipeline imports are needed in the MCP server.

### 3.2 MCP server code structure

**Location:** `/Users/mattjones/Documents/RepoGraph/packages/mcp-server/src/`

**Files:**
- `index.ts` -- main server, 7 tools registered inline, calls `registerRuntimeTools()`
- `runtime-tools.ts` -- 5 runtime tools, registered via `registerRuntimeTools(server, getSession, getSupabase, scopedRepo)`
- `repo-resolver.ts` -- helper for resolving repo names to IDs

**Registration pattern (established by `runtime-tools.ts`):**
```typescript
export function registerTemporalTools(
  server: McpServer,
  getSession: GetSessionFn,
  getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void { ... }
```

The new `temporal-tools.ts` file should follow this exact pattern. Wire it in `index.ts` with:
```typescript
import { registerTemporalTools } from "./temporal-tools.js";
// ... after registerRuntimeTools()
registerTemporalTools(server, getSession, getSupabase, SCOPED_REPO);
```

### 3.3 Supabase/Neo4j connection setup

The MCP server already has both connections:
- `getSession()` -- returns a Neo4j Session (lines 32-36 of `index.ts`)
- `getSupabase()` -- returns a SupabaseClient (lines 38-46 of `index.ts`)
- `getScopedRepoId()` -- resolves `REPOGRAPH_REPO` env var to Supabase UUID (lines 54-66)

These are passed to tool registration functions. Phase 6 can reuse all of them.

### 3.4 `repo-resolver.ts` utility

The `resolveRepoId` helper in `repo-resolver.ts` resolves repo name/URL to Supabase ID. The `get_complexity_trend` tool will need this to convert a user-supplied repo name into a `repo_id` for Supabase queries.

---

## 4. Summary of Issues for Phase 6

| # | Issue | Severity | Action Required |
|---|-------|----------|----------------|
| 1 | `churn_rate` metric not computed by complexity.ts | Medium | Either add computation or restrict MCP tool parameter |
| 2 | No backfill trigger wired to API/digest | Medium | Add route or DigestRequest flag before/during Phase 6 |
| 3 | Existing MCP queries return duplicates with temporal data | High | Phase 6 MUST add `valid_to IS NULL` filter to all queries |
| 4 | All interfaces align (temporal-loader writes all needed props) | -- | No action needed |
| 5 | INTRODUCED_IN edges correctly created for all change types | -- | No action needed |
| 6 | Supabase complexity_metrics schema matches write pattern | -- | No action needed |
| 7 | MCP server connection setup is ready | -- | No action needed |

### Phase 6 Build Readiness: READY with caveats

The core temporal data layer (Phases 1-5) is complete and consistent. Phase 6 can proceed. The two medium-severity items (churn_rate, backfill trigger) are non-blocking for the MCP tools themselves but represent incomplete PRD coverage. The high-severity item (existing query temporal filtering) is explicitly part of Phase 6's scope and must not be skipped.
