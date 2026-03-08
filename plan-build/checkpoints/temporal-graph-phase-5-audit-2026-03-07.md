# Phase 5 Audit: Complexity Metrics + Historical Backfill

**Date:** 2026-03-07
**Phase:** 5 — Complexity Metrics + Historical Backfill
**Status:** PASS with findings (2 missing features, 1 performance concern)

## Files Audited

- `packages/backend/src/pipeline/complexity.ts` (new)
- `packages/backend/src/pipeline/backfill.ts` (new)
- `packages/backend/src/pipeline/digest.ts` (modified)

---

## Checklist Verification

### 1. Cypher queries in complexity.ts — PASS

- **Property names correct:** Uses `f.path` (File node property), `repo_url` parameter, `IMPORTS` edge type, `CONTAINS` edge type — all match the existing loader patterns in `loader.ts`.
- **Temporal filter present:** All three queries include `valid_to IS NULL OR NOT EXISTS(...)` guard, correctly handling both temporal and non-temporal repos.
- **Import count query (line 43-48):** `(f:File)-[r:IMPORTS]->(target:File)` with filter on `r.valid_to` — correct. Filters on the edge's temporal field, not the node's.
- **Reverse import query (line 61-66):** Same pattern with reversed direction — correct.
- **Symbol count query (line 79-85):** Filters on `sym.valid_to` (node-level) — correct.
- **Note:** Import count queries filter on `r.valid_to` (edge temporal field) while symbol count filters on `sym.valid_to` (node temporal field). Both are appropriate for their respective contexts.

### 2. Supabase inserts in complexity.ts — PASS

Column names in the insert (line 123-129):
- `repo_id` — matches schema
- `commit_sha` — matches schema (plan said `commit_id` but schema uses `commit_sha`)
- `file_path` — matches schema
- `metric_name` — matches schema
- `metric_value` — matches schema (`REAL` column, code sends `number`)
- `timestamp` — matches schema (`TIMESTAMPTZ` column, code sends ISO string)

Batching via `BATCH_SIZE = 500` is reasonable.

### 3. backfill.ts imports and function calls — PASS

All imports are valid and match their source modules:
- `simpleGit` from `simple-git` — correct
- `scanRepo` from `./scanner.js` — correct
- `parseFile`, `isSupportedLanguage`, types from `./parser.js` — correct
- `resolveImports` from `./resolver.js` — correct
- `loadToNeo4j` from `./loader.js` — correct (used for File node MERGE)
- `ingestCommitHistory`, `CommitMeta` from `./commit-ingester.js` — correct
- `diffGraph` from `./differ.js` — correct
- `temporalLoad` from `./temporal-loader.js` — correct
- `computeComplexityMetrics` from `./complexity.js` — correct

Function call signatures match:
- `diffGraph(repoUrl, allSymbols, resolveResult.imports, [])` — 4 args match `diffGraph(repoUrl, currentSymbols, currentImports, currentCalls)`. Empty CALLS array is intentional (SCIP skipped).
- `temporalLoad(repoUrl, changeset, commit)` — 3 args match `temporalLoad(repoUrl, changeset, commit: CommitMeta)`.
- `computeComplexityMetrics(repoUrl, repoId, commit.sha, commit.timestamp.toISOString())` — 4 args match function signature.

### 4. backfill.ts error handling — PASS

Per-commit error handling is correct (lines 101-170):
- Inner try/catch around each commit's processing (line 101)
- On failure: logs error, pushes to `errors` array, continues to next commit (line 169: comment confirms "Continue to next commit")
- Does NOT abort the entire backfill on single-commit failure

### 5. backfill.ts HEAD restoration — PASS

- Stores original HEAD before loop (line 97): `const originalHead = (await git.revparse(["HEAD"])).trim()`
- Restores in `finally` block (lines 172-179): `await git.checkout(originalHead)`
- Handles restore failure gracefully with a warning log

### 6. backfill.ts progress tracking — PASS

- Creates `temporal_digest_jobs` row at start (lines 79-91) with status "running"
- Updates `commits_processed` after each successful commit (lines 159-164)
- Marks job complete/completed_with_errors in finally-adjacent block (lines 184-195)
- Stores `stats`, `error_log`, and `completed_at` on completion

### 7. digest.ts complexity metrics wiring — PASS

- `computeComplexityMetrics` is called at lines 422-428, inside the temporal path (`if (useTemporal)`)
- Called AFTER `temporalLoad()` completes (line 402) — correct ordering
- Wrapped in try/catch with `console.warn` — non-fatal as required
- Import at line 15: `import { computeComplexityMetrics } from "./complexity.js"` — correct

### 8. Missing: churn_rate metric — FAIL (not implemented)

The build plan (line 369) specifies:
> Compute churn_rate from temporal history (count commits that modified this file)

The Supabase schema comment (migration line 33) lists `churn_rate` as an expected metric name.

**However, `complexity.ts` does NOT compute churn_rate.** It only computes:
- `import_count`
- `reverse_import_count`
- `symbol_count`
- `coupling_score`

No Cypher query counts the number of commits that modified each file. The `churn_rate` metric is completely absent from the implementation.

**Impact:** The `get_complexity_trend` MCP tool (Phase 6) will have no churn data to query. Users cannot track file churn over time.

**Suggested fix:** Add a fourth Cypher query to `computeComplexityMetrics`:
```cypher
MATCH (f:File {repo_url: $repoUrl})-[:CONTAINS]->(sym)-[:INTRODUCED_IN]->(c:Commit)
WHERE sym.valid_to IS NULL OR NOT EXISTS(sym.valid_to)
RETURN f.path AS filePath, count(DISTINCT c) AS churnRate
```
Or alternatively, query all versions of symbols in each file (both current and historical) to count how many distinct commits touched each file.

### 9. Missing: git diff --name-only optimization — FAIL (scans ALL files per commit)

The build plan (lines 378-380) specifies:
> Per commit: `git diff --name-only` vs previous, checkout, scan changed files
> Carry forward unchanged files from previous iteration

**However, `backfill.ts` scans ALL files at every commit** (line 110):
```typescript
const allFiles = await scanRepo(localPath);
```

There is no `git diff --name-only` call. There is no "carry forward" of unchanged files between iterations. Every commit re-scans the entire repo tree.

**Impact:** Performance. For a repo with 1,000 files and 50 commits, this does 50,000 file scans instead of scanning only the ~5-50 changed files per commit. This could be 10-100x slower than planned.

**Additionally:** The plan (line 384) says to handle deleted files via `git diff --name-only --diff-filter=D`. Since there's no git diff at all, deleted file detection relies entirely on the diff engine comparing against Neo4j state. This should still work correctly but is less efficient.

**Suggested fix:** Before `scanRepo`, run:
```typescript
const prevSha = commits[i - 1]?.sha;
if (prevSha) {
  const diffOutput = await git.diff(["--name-only", prevSha, commit.sha]);
  const changedPaths = new Set(diffOutput.split("\n").filter(Boolean));
  // Only scan changed files; carry forward allFiles from previous iteration
}
```

---

## Summary

| # | Check | Result |
|---|-------|--------|
| 1 | Cypher queries correct | PASS |
| 2 | Supabase column names match | PASS |
| 3 | backfill.ts imports/calls valid | PASS |
| 4 | Per-commit error handling | PASS |
| 5 | Git HEAD restoration | PASS |
| 6 | Progress tracking in temporal_digest_jobs | PASS |
| 7 | computeComplexityMetrics wired after temporal load | PASS |
| 8 | churn_rate metric implemented | FAIL — not implemented |
| 9 | git diff --name-only optimization | FAIL — scans all files per commit |

**Verdict:** 7/9 checks pass. Two planned features are missing:
1. **churn_rate** — a metric the schema expects but the code never computes
2. **Incremental scanning** — a performance optimization the plan requires but the code skips

Neither missing feature causes runtime errors. The code is functionally correct for the metrics it does compute, and backfill will produce correct temporal history. The gaps are a missing metric and a performance concern that will matter at scale.
