# Temporal Graph Phase 4 Audit: Temporal Loader + Orchestrator

**Date:** 2026-03-07
**Auditor:** Claude Opus 4.6
**Files audited:**
- `/packages/backend/src/pipeline/temporal-loader.ts` (new, 544 lines)
- `/packages/backend/src/pipeline/digest.ts` (modified)

**Upstream dependencies verified:**
- `/packages/backend/src/pipeline/differ.ts` (GraphChangeset, NodeChange, EdgeChange, GraphNodeSnapshot, GraphEdgeSnapshot)
- `/packages/backend/src/pipeline/commit-ingester.ts` (CommitMeta, CommitIngestionResult)
- `/packages/backend/src/pipeline/loader.ts` (loadToNeo4j, loadImportsToNeo4j, loadDependenciesToNeo4j, countRepoGraph)
- `/packages/backend/src/pipeline/cloner.ts` (cloneRepo with depth parameter)

---

## Checklist Verification

### temporal-loader.ts

| Checklist Item | Status | Notes |
|---|---|---|
| Create `temporal-loader.ts` | PASS | File exists, exports `temporalLoad()` and `TemporalLoadResult` |
| `temporalLoadNodes(changeset, commitMeta)` for created nodes | PASS | Implemented as `createNodes()` — uses CREATE, groups by kind, correct label mapping, batched with BATCH_SIZE=500 |
| `temporalLoadNodes` for modified nodes | PASS | Implemented as `modifyNodes()` — close-out then create pattern |
| `temporalLoadNodes` for deleted nodes | PASS | Implemented as `closeOutNodes()` — sets valid_to + change_type="deleted" |
| `temporalLoadEdges` for IMPORTS edges | PASS | `createEdges()`, `modifyEdges()`, `closeOutEdges()` all handle IMPORTS |
| `temporalLoadEdges` for CALLS edges | PASS | `createEdges()` and `closeOutEdges()` handle CALLS |
| `createIntroducedInEdges(changeset, commitSha)` | PASS | Handles created+modified nodes AND deleted nodes separately |
| `closeOutFiles(repoUrl, filePaths, commitMeta)` | **FAIL** | NOT IMPLEMENTED — see Finding #1 |

### digest.ts

| Checklist Item | Status | Notes |
|---|---|---|
| Add `temporal?: boolean` flag to DigestRequest | PARTIAL | Not a flag — inferred from `!!headCommit` at line 384. This works but differs from the plan. |
| `historyDepth` on DigestRequest | PASS | Added at line 28 |
| Wire `ingestCommitHistory()` after clone | PASS | Lines 265-277, wrapped in try/catch |
| `headCommit` extracted from ingestion result | PASS | `ingestionResult.commits[0]` at line 271 |
| Branch: if temporal, use diff->temporalLoad | PASS | Lines 389-412 |
| Skip `purgeImportEdges()` / `purgeCallsEdges()` in temporal path | PASS | Neither is called in the temporal branch |
| Classic (non-temporal) path unchanged | PASS | Lines 414-478, identical to pre-existing logic |
| Update DigestStats with temporal fields | PARTIAL | `TemporalLoadResult` is appended to job stats as `temporal` subobject (line 509) but `DigestStats` type itself was not updated — see Finding #7 |

---

## Execution Chain Verification

### 1. GraphChangeset consumption

`temporalLoad()` receives a `GraphChangeset` and accesses `changeset.nodes` and `changeset.edges`, filtering by `changeType`. This matches the `GraphChangeset` type from `differ.ts` which has `nodes: NodeChange<GraphNodeSnapshot>[]` and `edges: EdgeChange[]`, each with a `changeType` field. **PASS**.

### 2. CommitMeta consumption

`temporalLoad()` accesses `commit.sha`, `commit.timestamp.toISOString()`, `commit.author`, `commit.message`. The `CommitMeta` type has `sha: string`, `timestamp: Date`, `author: string`, `message: string`. **PASS** — `.toISOString()` correctly converts `Date` to ISO string for Neo4j `datetime()`.

### 3. Cypher query correctness

| Query | CREATE vs MERGE | Verdict |
|---|---|---|
| `createNodes` (line 148-159) | Uses CREATE for node | PASS |
| `createNodes` CONTAINS edge (line 159) | Uses MERGE for CONTAINS edge | See Finding #2 |
| `modifyNodes` close-out (line 184-195) | Uses MATCH + SET | PASS |
| `modifyNodes` new version (line 198-223) | Uses CREATE for node, MERGE for CONTAINS | See Finding #2 |
| `closeOutNodes` (line 252-259) | Uses MATCH + SET | PASS |
| `createEdges` IMPORTS (line 293-303) | Uses CREATE | PASS |
| `createEdges` CALLS (line 322-333) | Uses CREATE | PASS |
| `modifyEdges` close-out (line 356-367) | Uses MATCH + SET | PASS |
| `modifyEdges` new version (line 370-388) | Uses CREATE | PASS |
| `closeOutEdges` IMPORTS (line 408-419) | Uses MATCH + SET | PASS |
| `closeOutEdges` CALLS (line 425-436) | Uses MATCH + SET | PASS |
| `createIntroducedInEdges` (line 489-496) | Uses CREATE | PASS |

### 4. Property names

| Required Property | Present in CREATE queries | Correct |
|---|---|---|
| `valid_from` | Yes (line 140) | PASS |
| `valid_from_ts` | Yes, `datetime(s.valid_from_ts)` (line 155) | PASS |
| `valid_to` | **NOT SET on create** | See Finding #3 |
| `valid_to_ts` | **NOT SET on create** | See Finding #3 |
| `change_type` | Yes (line 142) | PASS |
| `changed_by` | Yes (line 143) | PASS |
| `commit_message` | Yes (line 144) | PASS |

### 5. Label generation

`KIND_TO_LABEL` mapping (line 35-40): function->Function, class->Class, type->TypeDef, constant->Constant. Matches existing Neo4j labels used in `loader.ts` and `differ.ts`. **PASS**.

### 6. INTRODUCED_IN edge targets

Line 493: `MATCH (c:Commit {sha: $sha, repo_url: $repoUrl})` — matches the Commit node structure created by `commit-ingester.ts` line 103: `MERGE (commit:Commit {sha: c.sha, repo_url: c.repo_url})`. **PASS**.

---

## Data Flow Verification

### digest.ts -> temporal-loader.ts

1. `headCommit` is extracted at line 271 from `ingestionResult.commits[0]` (the HEAD/most recent commit). **PASS**.
2. `changeset` comes from `diffGraph(req.url, allSymbols, resolveResult.imports, callsEdges)` at line 394. The `diffGraph` function signature in `differ.ts` line 201 expects `(repoUrl, currentSymbols, currentImports, currentCalls)`. **PASS** — types align.
3. Temporal branch still loads File nodes via `loadToNeo4j()` at line 397. **PASS**.
4. Dependencies loaded via `loadDependenciesToNeo4j()` at line 404. **PASS**.
5. DIRECTLY_IMPORTS and EXPORTS loaded via `loadImportsToNeo4j()` at line 408. **PASS**.
6. `countRepoGraph()` called at line 411 to get totals. **PASS**.

---

## Findings

### Finding #1 (SEVERITY: HIGH) — `closeOutFiles()` NOT IMPLEMENTED

The plan explicitly requires: "Implement `closeOutFiles(repoUrl, filePaths, commitMeta)` to replace `removeFilesFromNeo4j` in temporal mode." This function does not exist anywhere in the codebase. The temporal path in `digest.ts` does not handle deleted files at all for Neo4j — `removeFilesFromSupabase()` is called for deleted paths (line 379-381), but in the temporal branch there is no corresponding Neo4j operation to close out File nodes and their contained symbols.

**Impact:** When files are deleted, the temporal path will leave orphaned File nodes and symbol nodes in Neo4j with `valid_to IS NULL` — they appear as current even though they no longer exist.

**Fix required:**
1. Implement `closeOutFiles(repoUrl, filePaths, commitMeta)` in `temporal-loader.ts`
2. It should: `MATCH (f:File {path: $path, repo_url: $repoUrl}) WHERE f.valid_to IS NULL SET f.valid_to = $sha, f.valid_to_ts = datetime($ts)` and also close out all CONTAINS'd symbols
3. Wire into digest.ts temporal branch: if `deletedPaths.length > 0`, call `closeOutFiles()` instead of `removeFilesFromNeo4j()`

### Finding #2 (SEVERITY: MEDIUM) — MERGE on CONTAINS edge may link to wrong node version

In `createNodes()` (line 159) and `modifyNodes()` (line 209), the CONTAINS edge uses `MERGE (f)-[:CONTAINS]->(n)`. Since `n` was just CREATEd in the same query, the MERGE is effectively a CREATE (it cannot match an existing edge to a brand-new node). This is functionally correct but semantically misleading. However, there is a subtle issue: the MATCH on File node at line 149 (`MATCH (f:File {path: s.file_path, repo_url: s.repo_url})`) does not filter for `valid_to IS NULL`. If File nodes ever get temporal versioning, this would match multiple File versions. Currently File nodes are loaded via classic MERGE (line 397 in digest.ts) so they don't have temporal fields — this is safe for now but fragile.

**Impact:** Low risk currently, but will break if File nodes become temporal.

**Fix suggested:** Add `WHERE f.valid_to IS NULL OR NOT EXISTS(f.valid_to)` to the File MATCH in `createNodes()` and `modifyNodes()`.

### Finding #3 (SEVERITY: LOW) — `valid_to` not explicitly set to null on created nodes

The plan says created nodes should have `valid_to: null`. The CREATE query in `createNodes()` (line 150-158) does not include `valid_to` or `valid_to_ts` properties. In Neo4j, a missing property and a null property behave differently: `n.valid_to IS NULL` returns true for both, but `NOT EXISTS(n.valid_to)` returns true only for missing. The close-out queries use `WHERE n.valid_to IS NULL OR NOT EXISTS(n.valid_to)` which covers both cases, so this works. However, for consistency and query simplicity, it would be cleaner to explicitly set `valid_to: null, valid_to_ts: null`.

**Impact:** No functional bug. Queries work due to the OR clause. But downstream MCP tools that filter with `WHERE n.valid_to IS NULL` (without the OR) would incorrectly miss these nodes.

**Fix suggested:** Add `valid_to: null, valid_to_ts: null` to CREATE queries in `createNodes()`, `modifyNodes()`, `createEdges()`.

### Finding #4 (SEVERITY: MEDIUM) — CALLS edge creation may match old (closed-out) symbol versions

In `createEdges()` for CALLS (line 322-327), the MATCH clause finds caller/callee by `{name, file_path, repo_url}` without filtering `WHERE caller.valid_to IS NULL`. If a symbol was modified in the same changeset, both the old (closed-out) and new version exist. The MATCH will return both, creating duplicate CALLS edges — one to the old version and one to the new version.

**Impact:** On any commit that both modifies a function AND that function has CALLS edges, you get spurious CALLS edges pointing to the closed-out version.

**Fix required:** Add `AND (caller.valid_to IS NULL OR NOT EXISTS(caller.valid_to))` and same for callee to the CALLS creation query. Same fix needed in `closeOutEdges()` for CALLS (line 426-428 already has the filter on the edge but not on the nodes — though for close-out the node filter matters less since you're matching by the edge's valid_to).

### Finding #5 (SEVERITY: MEDIUM) — `modifyNodes()` is not batched

`modifyNodes()` (line 170-229) processes nodes one at a time in a for loop, running two separate queries per node (close-out + create). For a large commit modifying hundreds of symbols, this generates hundreds of individual Neo4j queries. `createNodes()` and `closeOutNodes()` use UNWIND batching correctly.

**Impact:** Performance degradation on commits with many modified symbols.

**Fix suggested:** Batch the close-out step and the create step separately, similar to `createNodes()`.

### Finding #6 (SEVERITY: LOW) — `modifyEdges()` silently ignores CALLS edge modifications

Line 390-393: `modifyEdges()` only handles IMPORTS edges. The comment at line 390 says "CALLS edges don't track modifications." This aligns with `differ.ts` (line 304-305) which doesn't generate "modified" CALLS edges. Consistent, but worth documenting — if the differ is ever updated to detect CALLS modifications, the loader will silently drop them.

**Impact:** None currently. Documenting for awareness.

### Finding #7 (SEVERITY: LOW) — `DigestStats` type not updated with temporal fields

The plan says: "Update `DigestStats` with temporal-specific fields: `commitsIngested`, `nodesVersioned`, `edgesVersioned`." The `DigestStats` type (line 38-57) was not updated. Instead, the temporal result is appended as a separate `temporal` subobject in `jobStats` (line 509). The `DigestResult` type was also not updated with a `temporal` flag.

**Impact:** TypeScript consumers of `DigestResult` don't see temporal stats in the type system. The data IS persisted to Supabase but without type safety.

**Fix suggested:** Add to `DigestStats`:
```typescript
commitsIngested?: number;
temporal?: TemporalLoadResult;
```
And add `temporal?: boolean` to `DigestResult`.

### Finding #8 (SEVERITY: LOW) — INTRODUCED_IN for deleted nodes uses `valid_to = $sha` match

In `createIntroducedInEdges()` (line 518-519), deleted node INTRODUCED_IN edges match with `WHERE n.valid_to = $sha`. This is correct — deleted nodes just had their `valid_to` set to the current commit SHA. However, if `closeOutNodes()` fails partway through (partial batch), some deleted nodes won't have `valid_to` set, and the INTRODUCED_IN edge won't be created for them. There's no transaction wrapping the entire temporal load.

**Impact:** Data inconsistency on partial failures. Low probability in practice.

**Fix suggested:** Wrap the entire `temporalLoad()` body in a Neo4j transaction (use `session.writeTransaction()`).

---

## Edge Case Analysis

### First temporal digest (no previous state)

`diffGraph()` calls `fetchPreviousGraphState()` which queries for nodes with `valid_to IS NULL`. On a fresh repo with no temporal fields, this returns all existing nodes (the `OR NOT EXISTS(n.valid_to)` clause handles nodes without the property). If this is truly the first digest (no nodes exist), all current symbols become "created" in the changeset. **PASS** — correct behavior.

However, if a repo was previously digested with the classic path (nodes exist without temporal fields), the diff engine will correctly detect them as "previous state" and diff against them. Modified/unchanged symbols will be handled correctly. **PASS**.

### Commit ingestion fails (headCommit is undefined)

If `ingestCommitHistory()` throws (caught at line 274), `headCommit` remains `undefined`. The `useTemporal = !!headCommit` check at line 384 evaluates to false, so the classic path is used. **PASS** — graceful fallback.

### CALLS edges reference just-created symbols

See Finding #4. The `createEdges()` CALLS query matches by name/file_path/repo_url without `valid_to` filter. For newly created symbols (no old version exists), this works fine. For modified symbols (old + new version both exist), this creates duplicate edges. **FAIL** for modified symbols.

---

## Summary

| Severity | Count | Items |
|---|---|---|
| HIGH | 1 | Missing `closeOutFiles()` implementation |
| MEDIUM | 3 | CALLS edge duplicate on modified symbols; CONTAINS MERGE fragility; modifyNodes not batched |
| LOW | 4 | valid_to not set to null; CALLS modify silently ignored; DigestStats type not updated; no transaction wrapping |

**Verdict: Phase 4 is substantially complete but has one HIGH-severity gap (`closeOutFiles`) that must be addressed before this can be considered wired. The CALLS edge duplication on modified symbols (Finding #4) should also be fixed to prevent data corruption in common incremental digest scenarios.**
