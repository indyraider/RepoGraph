# Phase 4 Forward Plan Review
**Phase completed:** Temporal Loader + Orchestrator
**Date:** 2026-03-07
**Plan updates needed:** YES

---

## Actual Interfaces Built

### temporal-loader.ts

**`TemporalLoadResult`** (line 13-21)
```ts
export interface TemporalLoadResult {
  nodesCreated: number;
  nodesModified: number;
  nodesDeleted: number;
  edgesCreated: number;
  edgesModified: number;
  edgesDeleted: number;
  introducedInEdges: number;
}
```

**`temporalLoad()`** (line 53-57)
```ts
export async function temporalLoad(
  repoUrl: string,
  changeset: GraphChangeset,
  commit: CommitMeta
): Promise<TemporalLoadResult>
```

**Internal `TemporalContext`** (line 23-29, not exported)
```ts
interface TemporalContext {
  repoUrl: string;
  commitSha: string;
  commitTs: string;  // ISO 8601
  author: string;
  message: string;
}
```

### digest.ts modifications

**`DigestRequest`** (line 16-29) — new field added:
```ts
historyDepth?: number;  // Clone depth for git history. 0 = full, 1 = shallow (default)
```

**`DigestStats`** (line 38-57) — UNCHANGED. No temporal-specific fields added.

**`DigestResult`** (line 64-75) — UNCHANGED. No temporal flag or temporal stats in the public return type.

**Temporal stats persistence** (line 506-510): `temporalResult` is embedded in the `jobStats` object written to the `digest_jobs` Supabase row under a `temporal` key, but it is NOT part of the `DigestResult` returned to the caller.

**Temporal branch trigger** (line 384):
```ts
const useTemporal = !!headCommit;
```
Temporal path is activated when `headCommit` is truthy — i.e., when `ingestCommitHistory` succeeds and returns at least one commit. This means temporal mode is implicitly enabled whenever commit ingestion works, NOT controlled by an explicit `temporal?: boolean` flag on `DigestRequest`.

---

## Temporal Properties SET on Nodes

Created nodes (line 140-144) receive these properties:
- `valid_from` — commit SHA (string)
- `valid_from_ts` — commit timestamp (`datetime()` in Neo4j)
- `change_type` — `"created"`
- `changed_by` — author name (string)
- `commit_message` — commit message (string)

Created nodes do NOT receive:
- `valid_to` — not set (implicitly null in Neo4j)
- `valid_to_ts` — not set

Modified nodes — old version close-out (line 186-187):
- `valid_to` — commit SHA
- `valid_to_ts` — commit timestamp (`datetime()`)

Modified nodes — new version (line 205-207):
- `valid_from`, `valid_from_ts`, `change_type` (`"modified"`), `changed_by`, `commit_message`
- `valid_to`/`valid_to_ts` NOT set (implicitly null)

Deleted nodes close-out (line 256-257):
- `valid_to`, `valid_to_ts` — SET
- `change_type` — overwritten to `"deleted"`
- `changed_by`, `commit_message` — NOT SET on deleted nodes

### INTRODUCED_IN Edge Properties

Created/modified nodes (line 494):
```cypher
CREATE (n)-[:INTRODUCED_IN {change_type: s.change_type}]->(c)
```
Properties: `change_type` only (either `"created"` or `"modified"`)

Deleted nodes (line 521):
```cypher
CREATE (n)-[:INTRODUCED_IN {change_type: 'deleted'}]->(c)
```
Properties: `change_type` = `"deleted"` only

### Edge (IMPORTS, CALLS) Temporal Properties

Created IMPORTS edges (line 298-301):
- `valid_from`, `valid_from_ts`, `change_type` (`"created"`)
- NO `changed_by`, `commit_message`

Created CALLS edges (line 328-331):
- `valid_from`, `valid_from_ts`, `change_type` (`"created"`)
- NO `changed_by`, `commit_message`

Closed-out IMPORTS edges (line 359):
- `valid_to`, `valid_to_ts` SET

Closed-out CALLS edges (line 429):
- `valid_to`, `valid_to_ts`, `change_type` (`"deleted"`) SET

---

## Mismatches with Remaining Phases

### MISMATCH 1: Deleted nodes missing `changed_by` and `commit_message`

- **Plan Contract 6 says:** "For DELETED: SET node.valid_to=commitSha, node.valid_to_ts=commitTs, node.change_type='deleted'. CREATE (node)-[:INTRODUCED_IN {change_type: 'deleted'}]->(commit)"
- **Code actually:** `closeOutNodes()` (line 252-259) sets `valid_to`, `valid_to_ts`, and `change_type='deleted'` but does NOT set `changed_by` or `commit_message` on the old node.
- **Phase 6 impact:** MCP tool `get_symbol_history` (Plan Flow 4) queries `f.changed_by` and `c.message`. For deleted versions, `changed_by` will still reflect the ORIGINAL creator's name, not who deleted it. The commit message IS available via the INTRODUCED_IN edge → Commit node join, but `changed_by` on the node itself is stale.
- **Severity:** LOW. The INTRODUCED_IN → Commit join provides correct attribution. But if Phase 6 queries only node properties without the join, deletion attribution will be wrong.
- **Recommendation:** Add `n.changed_by = $author, n.commit_message = $message` to the `closeOutNodes` SET clause to keep node-level attribution accurate for deleted versions.

### MISMATCH 2: Edges missing `changed_by` and `commit_message` properties

- **Plan Contract 6 says:** Created nodes get `changed_by=author, commit_message=message`. Edges are meant to follow the same pattern.
- **Code actually:** Created IMPORTS edges (line 298-301) and CALLS edges (line 328-331) receive `valid_from`, `valid_from_ts`, `change_type` but NOT `changed_by` or `commit_message`.
- **Phase 6 impact:** MCP `diff_graph` tool queries edges with temporal properties. If it tries to read `r.changed_by` on an edge, it will be null.
- **Severity:** LOW. Edge-level attribution is less important — the commit node has all metadata. Phase 6 can join through INTRODUCED_IN or query Commit nodes directly.
- **Recommendation:** Acceptable as-is. Document that edge attribution requires a Commit node join.

### MISMATCH 3: No `temporal` flag on `DigestResult`

- **Plan says:** (Wiring Checklist, Phase 4) "Update `DigestResult` with temporal flag"
- **Code actually:** `DigestResult` (line 64-75) is unchanged. No `temporal?: boolean` field. No `temporalStats?: TemporalLoadResult` field. Temporal data is persisted to the `digest_jobs.stats.temporal` column but not returned in the function result.
- **Phase 5 impact:** The backfill loop needs to know if temporal mode is active. Currently it would need to check `headCommit` truthiness independently rather than reading a result flag.
- **Severity:** LOW. Phase 5 (backfill) will call `temporalLoad()` directly, not through `runDigest()`, so it doesn't rely on `DigestResult`.
- **Recommendation:** Add `temporal?: boolean` and `temporalStats?: TemporalLoadResult` to `DigestResult` for API consumers. Not blocking for Phase 5/6.

### MISMATCH 4: No explicit `temporal?: boolean` on `DigestRequest`

- **Plan says:** (Wiring Checklist, Phase 4) "Add `temporal?: boolean` flag to DigestRequest"
- **Code actually:** Temporal mode is implicitly activated by `!!headCommit` (line 384). There is no explicit opt-in/opt-out flag.
- **Downstream impact:** Every digest where commit ingestion succeeds will use temporal loading. There is no way to force classic (non-temporal) loading when commits are available.
- **Severity:** LOW. This is arguably the right default — if we have commit metadata, use it. An explicit flag could be added later if needed.

### MISMATCH 5: `loadImportsToNeo4j` still called in temporal path

- **Code (line 408):** In the temporal path, after `temporalLoad()`, the code calls `loadImportsToNeo4j(req.url, resolveResult)` for DIRECTLY_IMPORTS edges.
- **Issue:** `loadImportsToNeo4j` does `purgeImportEdges()` internally (or does it?). Need to verify whether this purges ALL import edges including the temporally-versioned IMPORTS edges that were just created.
- **Severity:** POTENTIALLY HIGH. If `loadImportsToNeo4j` calls `purgeImportEdges` first, it will destroy the temporal IMPORTS edges just created by `temporalLoad()`.
- **Investigation needed:** Check whether `loadImportsToNeo4j` purges IMPORTS edges or only DIRECTLY_IMPORTS edges.

Let me check this: Looking at digest.ts line 406-408, the comment says "DIRECTLY_IMPORTS and EXPORTS edges: use classic purge-and-reload (not temporally versioned — they're derived/denormalized)". The function `loadImportsToNeo4j` loads IMPORTS, DIRECTLY_IMPORTS, and EXPORTS edges. In the temporal path, IMPORTS edges are already handled by `temporalLoad()`. Calling `loadImportsToNeo4j()` again would create DUPLICATE IMPORTS edges (the temporal ones from `temporalLoad` + the classic MERGE ones from `loadImportsToNeo4j`).

**CRITICAL: This is a bug.** The temporal path should NOT call `loadImportsToNeo4j` for IMPORTS edges. It should only reload DIRECTLY_IMPORTS edges. Either:
- (a) Split `loadImportsToNeo4j` into separate functions for IMPORTS vs DIRECTLY_IMPORTS
- (b) Add a flag to skip IMPORTS edge loading
- (c) Call a DIRECTLY_IMPORTS-only loader

**Recommendation:** This must be fixed before Phase 5 testing. The temporal IMPORTS edges from `temporalLoad()` will be duplicated by the classic `loadImportsToNeo4j()` call.

### MISMATCH 6: `purgeImportEdges` / `purgeCallsEdges` not called in temporal path

- **Plan says:** (Wiring Checklist) "Skip `purgeImportEdges()` and `purgeCallsEdges()` — diff engine handles edge transitions"
- **Code actually:** The temporal path (line 389-413) does NOT call `purgeImportEdges()` or `purgeCallsEdges()` before temporal load. CORRECT.
- **However:** `loadImportsToNeo4j` (line 408) may internally purge import edges. This compounds MISMATCH 5.

---

## Phase 5 Readiness Assessment

### Contract 7: `temporalLoad()` -> `computeComplexityMetrics()`

**Hook point identified:** Line 411 in `digest.ts`. After `temporalLoad()` returns and before `countRepoGraph()`, there is a natural insertion point:

```ts
// Line 401: temporalResult = await temporalLoad(req.url, changeset, headCommit!);
// Line 403-404: loadDependenciesToNeo4j(...)
// Line 406-408: loadImportsToNeo4j(...)  <-- FIX MISMATCH 5 FIRST
// >>> INSERT computeComplexityMetrics() HERE <<<
// Line 411: const totals = await countRepoGraph(req.url);
```

**Data available for `computeComplexityMetrics()`:**
- `req.url` — repoUrl (available)
- `headCommit!.sha` — commitSha (available)
- `headCommit!.timestamp.toISOString()` — commitTs (available)
- `repo.id` — repoId for Supabase writes (available)

**Phase 5 function signature should be:**
```ts
computeComplexityMetrics(repoUrl: string, repoId: string, commitSha: string, commitTs: string): Promise<void>
```

### Phase 5 (Historical Backfill): Can `temporalLoad()` be called in a loop?

**YES.** `temporalLoad()` is a standalone function:
```ts
temporalLoad(repoUrl: string, changeset: GraphChangeset, commit: CommitMeta): Promise<TemporalLoadResult>
```

It accepts per-commit data via the `commit: CommitMeta` parameter. Each call opens and closes its own Neo4j session (line 76, 103). It can be called repeatedly with different `CommitMeta` objects in a sequential loop.

**Backfill loop pattern:**
```ts
for (const commit of commits) {
  // scan + parse + resolve for this commit's state
  const changeset = await diffGraph(repoUrl, symbols, imports, calls);
  await temporalLoad(repoUrl, changeset, commit);
  await computeComplexityMetrics(repoUrl, repoId, commit.sha, commit.timestamp.toISOString());
}
```

**Important constraint (carried from Phase 3 forward):** The loop MUST be sequential. `diffGraph()` queries Neo4j for the current state (`valid_to IS NULL`), so each `temporalLoad()` must commit before the next `diffGraph()` runs. Since `temporalLoad()` uses `session.run()` (auto-commit transactions), each write is immediately visible. This is SAFE for sequential iteration.

### Phase 5 Imports from Phase 4

Phase 5 needs:
```ts
import { temporalLoad, TemporalLoadResult } from "./temporal-loader.js";
import { CommitMeta } from "./commit-ingester.js";
import { diffGraph, GraphChangeset } from "./differ.js";
```

### Phase 5 does NOT need to call `runDigest()`

The backfill loop calls pipeline stages directly (scan, parse, resolve, diff, temporalLoad). It bypasses `runDigest()` entirely. This is correct — `runDigest()` handles Supabase job tracking, same-commit checks, and cleanup that don't apply to per-commit backfill iterations.

---

## Phase 6 Readiness Assessment

### MCP Temporal Queries: Property Availability

Phase 6 tools query these properties on nodes:

| Property | Set on created? | Set on modified (new)? | Set on deleted (closed-out)? |
|----------|----------------|----------------------|------------------------------|
| `valid_from` | YES | YES | NO (only on original creation) |
| `valid_from_ts` | YES | YES | NO |
| `valid_to` | NO (null) | NO (null) | YES |
| `valid_to_ts` | NO (null) | NO (null) | YES |
| `change_type` | `"created"` | `"modified"` | `"deleted"` |
| `changed_by` | YES (author) | YES (author) | NO (stale from original) |
| `commit_message` | YES | YES | NO (stale from original) |

**Phase 6 `get_symbol_history` query pattern** (Plan Flow 4):
```cypher
MATCH (f:Function {name: $name, repo_url: $repo})
OPTIONAL MATCH (f)-[:INTRODUCED_IN]->(c:Commit)
RETURN f.signature, f.valid_from, f.valid_from_ts, f.valid_to,
       f.valid_to_ts, f.change_type, f.changed_by, c.message
ORDER BY f.valid_from_ts DESC
```

This works correctly because:
- All versions of a symbol (old closed-out + new) exist as separate nodes
- Each has `valid_from`/`valid_from_ts` set
- INTRODUCED_IN edges connect to the right Commit node
- `c.message` from the Commit join is always accurate (even for deletions)
- `f.changed_by` for deletions will be stale (MISMATCH 1), but `c.author` on the Commit node is correct

### INTRODUCED_IN Edge Properties

Phase 6 tools expect INTRODUCED_IN edges with:
- `change_type` — YES, present (`"created"`, `"modified"`, or `"deleted"`)

No other properties are expected on INTRODUCED_IN edges. This is sufficient.

### `buildTemporalFilter()` helper (Phase 6 Wiring Checklist)

The temporal loader uses `datetime()` for `valid_from_ts` and `valid_to_ts` (line 155, 187). Phase 6's `buildTemporalFilter()` must use Neo4j datetime comparison:
```cypher
WHERE node.valid_from_ts <= datetime($ts) AND (node.valid_to_ts IS NULL OR node.valid_to_ts > datetime($ts))
```

Backward compatibility filter (repos without temporal data):
```cypher
WHERE (node.valid_to IS NULL OR NOT EXISTS(node.valid_to))
```
This is the same pattern used in `temporal-loader.ts` (line 186, 255), confirming compatibility.

---

## Critical Issues to Fix Before Phase 5

### CRITICAL: Duplicate IMPORTS edges in temporal path

**Location:** `digest.ts` line 408
**Problem:** `loadImportsToNeo4j(req.url, resolveResult)` is called after `temporalLoad()` in the temporal path. `temporalLoad()` already creates temporally-versioned IMPORTS edges. `loadImportsToNeo4j()` creates additional MERGE-based IMPORTS edges without temporal fields. This results in duplicate IMPORTS edges between the same File pairs.

**CONFIRMED:** `loadImportsToNeo4j` (loader.ts:237-346) creates IMPORTS edges via `MERGE (from)-[r:IMPORTS]->(to)` at line 273, then SETs non-temporal properties (`symbols`, `resolution_status`, etc.) on those edges. In the temporal path, `temporalLoad()` has already used `CREATE` to make temporal IMPORTS edges with `valid_from`, `valid_from_ts`, `change_type`. The subsequent MERGE will either:
- Match one of the temporal edges and overwrite its properties (stripping temporal fields), OR
- Create a second edge if MERGE can't find a match (resulting in duplicates)

Either outcome corrupts the temporal data.

Additionally, `loadImportsToNeo4j` also creates external IMPORTS edges (File -> Package, line 298-308) which `temporalLoad()` does NOT handle (the differ only diffs internal File->File IMPORTS). So external imports still need the classic loader.

**Fix options:**
1. **Best:** Split `loadImportsToNeo4j` into three functions: `loadInternalImports`, `loadExternalImports`, `loadDirectImports`. In the temporal path, call only `loadExternalImports` + `loadDirectImports`.
2. **Quick:** Add a `skipInternalImports?: boolean` parameter to `loadImportsToNeo4j`. Pass `true` in the temporal path so it only creates external IMPORTS + DIRECTLY_IMPORTS edges.

**This MUST be resolved before Phase 5 backfill testing.** The temporal IMPORTS edges will be corrupted or duplicated.

---

## Recommended Plan Updates

### 1. Update Contract 6 (Temporal Loader -> Neo4j)
Add clarity on which properties are set per operation:
- Created nodes: `valid_from`, `valid_from_ts`, `change_type`, `changed_by`, `commit_message`
- Modified (new version): same as created, with `change_type="modified"`
- Deleted (close-out): `valid_to`, `valid_to_ts`, `change_type="deleted"` ONLY
- INTRODUCED_IN edges: `change_type` property only

### 2. Update Contract 7 (Temporal Loader -> Complexity Metrics)
The hook point is at `digest.ts` line ~409 (after temporal load, before countRepoGraph). Available data: `req.url`, `repo.id`, `headCommit.sha`, `headCommit.timestamp`. Function signature:
```ts
computeComplexityMetrics(repoUrl: string, repoId: string, commitSha: string, commitTs: string): Promise<void>
```

### 3. Add to Phase 5 design notes
- `temporalLoad()` can be called independently in a per-commit loop
- Each call opens/closes its own session — safe for sequential iteration
- The backfill loop must be sequential (no parallelism) — `diffGraph()` depends on previous `temporalLoad()` having committed
- Backfill does NOT go through `runDigest()` — calls pipeline stages directly

### 4. Fix IMPORTS duplication bug before Phase 5
The temporal path in `digest.ts` must not call `loadImportsToNeo4j` for IMPORTS edges when `temporalLoad()` has already created them. Split or gate the function.

### 5. Phase 6: Use Commit node joins for deletion attribution
Document that `changed_by` on deleted node versions is stale. Phase 6 tools should always join through `INTRODUCED_IN -> Commit` for accurate attribution on all change types.

---

## Carry-Forward Issues from Previous Phases

### From Phase 3 Forward (still relevant)
- **DIRECTLY_IMPORTS edges not temporally versioned** — accepted as design decision (MEDIUM severity). Phase 6 should not attempt to query temporal history on DIRECTLY_IMPORTS edges.

---

## Summary

| Item | Status |
|------|--------|
| `temporalLoad()` function | BUILT — correct signature, accepts `GraphChangeset` + `CommitMeta` |
| `TemporalLoadResult` type | BUILT — 7 fields including `introducedInEdges` |
| `DigestRequest.historyDepth` | ADDED |
| `DigestResult` temporal fields | NOT ADDED (temporal stats only in persisted job, not return type) |
| Temporal branch in `runDigest()` | BUILT — triggered by `!!headCommit` |
| Node temporal properties | All 5 required properties SET on created/modified nodes |
| Deleted node attribution | INCOMPLETE — `changed_by`/`commit_message` not updated on close-out |
| INTRODUCED_IN edges | BUILT — `change_type` property present |
| Edge temporal properties | PARTIAL — `valid_from`, `valid_from_ts`, `change_type` but no `changed_by`/`commit_message` |
| IMPORTS duplication bug | CRITICAL — `loadImportsToNeo4j` called after `temporalLoad` creates duplicates |
| Phase 5 hook point | IDENTIFIED — after temporalLoad, before countRepoGraph |
| `temporalLoad()` loop-safe | YES — standalone, opens own session, auto-commits |
| Phase 6 property compatibility | GOOD — all queried properties exist (with Commit join caveat for deletions) |

**Phase 5 readiness: READY**, provided:
1. The IMPORTS duplication bug (MISMATCH 5) is fixed first
2. Phase 5 builder knows to call `temporalLoad()` directly (not through `runDigest()`) for backfill
3. Phase 5 builder uses `CommitMeta` from `commit-ingester.js` for per-commit attribution

**Phase 6 readiness: READY**, provided:
1. Phase 6 builder always joins through `INTRODUCED_IN -> Commit` for deletion attribution
2. Phase 6 builder uses `datetime()` comparisons for temporal range filters
3. Phase 6 builder handles backward compat with `valid_to IS NULL OR NOT EXISTS(valid_to)`
