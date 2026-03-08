# Phase 3 Audit: Loader + Orchestrator
**Date:** 2026-03-07
**Plan:** ../planning/codeql-data-flow-plan-2026-03-07.md
**Phase:** 3 — Loader + Orchestrator
**Status:** PASS WITH FINDINGS

## Files Audited

| File | Status | Notes |
|------|--------|-------|
| `codeql/types.ts` | OK | Phase 1 — all types present and correct |
| `codeql/runner.ts` | OK | Phase 1 — CLI spawning, timeout, cleanup all solid |
| `codeql/sarif-parser.ts` | OK | Phase 2 — deduplication, severity mapping, codeFlow extraction |
| `codeql/node-matcher.ts` | OK | Phase 2 — batch dedup, innermost-function matching, elementId() |
| `codeql/loader.ts` | PASS | Phase 3 — new file, findings below |
| `codeql/index.ts` | PASS | Phase 3 — new file, findings below |

---

## Execution Chain Verification

### Does `runCodeQLStage` correctly chain all steps?

**PASS.** The orchestrator follows this sequence:
1. Config check (`config.codeql.enabled`) -> line 85
2. CLI check (`isCodeQLAvailable()`) -> line 92
3. Language detection (`getCodeQLConfigsForLanguages()`) -> line 101
4. Per-language loop: create DB -> analyze -> parse SARIF -> cleanup DB -> lines 122-182
5. Match findings -> line 205
6. Load findings (purge + write) -> line 212
7. Stats update -> line 238
8. Session close -> line 241 (finally block)

Database cleanup happens per-language inside the loop (lines 142, 161, 181). Correct.

### Does the orchestrator handle partial success?

**PASS.** The `anySuccess` / `anyFailed` flags track per-language outcomes. If some languages succeed and others fail:
- `anySuccess = true, anyFailed = true` -> proceeds to matching/loading, status = `"partial"` (line 220)
- `!anySuccess && anyFailed` -> returns early with `"failed"` status (line 184)
- Only findings from successful languages are accumulated in `allFindings`

### Does `loadCodeQLFindings` correctly purge then write?

**PASS.** Follows the plan's Issue 2 fix (Option A): purge only runs when replacement data is ready.
- Empty findings: still purges (line 157-160) — correct, repo may have been fixed
- Non-empty findings: purge -> write nodes -> write edges (lines 163-170)

---

## Data Flow Verification

### Does orchestrator destructure `matchFindings()` return correctly?

**PASS.** Line 205: `const { matched, unmatchedCount } = await matchFindings(...)` — matches the return type `{ matched: MatchedFinding[]; unmatchedCount: number }` from `node-matcher.ts` line 84.

### Does the loader use `elementId()` for Neo4j 5 compatibility?

**PASS.** `writeFlowEdges()` uses `WHERE elementId(source) = e.source_id` and `WHERE elementId(sink) = e.sink_id` (loader.ts lines 124-125). This matches the `elementId()` usage in `node-matcher.ts` line 20 that produces the IDs.

### Are all types flowing correctly?

**PASS.** Full chain:
- `runner.ts` -> `CodeQLRunResult` (success/durationMs/error)
- `sarif-parser.ts` -> `CodeQLFinding[]` (queryId/severity/message/source/sink/pathSteps)
- `node-matcher.ts` -> `{ matched: MatchedFinding[], unmatchedCount }` (adds sourceNodeId/sinkNodeId/pathComplete)
- `loader.ts` -> `{ findingCount, flowEdgeCount }`
- `index.ts` -> `CodeQLStageResult` (stats + skipped flag)

All imports resolve correctly. `MatchedFinding extends CodeQLFinding` so all original fields propagate.

---

## Critical Checks

### Does `runCodeQLStage` truly never throw?

**PASS.** Top-level try/catch at lines 83-272. The outer catch (line 243) catches any unhandled error, logs it, and returns a result object. It also wraps the stats update in its own try/catch (lines 262-269) so even a Supabase failure during error reporting doesn't propagate.

### Does it always call `updateJobStats`?

**PASS.** Every exit path calls `updateJobStats`:
- Config disabled: line 87
- CLI not available: line 96
- No supported languages: line 107
- All languages failed: line 198
- Success/partial success: line 238
- Top-level catch: line 263

### Does it always close the Neo4j session?

**PASS WITH FINDING.** The session is created at line 203 and closed in a `finally` block at line 241. However:

**FINDING F-01 (LOW): Session not created for early-exit paths.** The session is only created after the per-language loop succeeds. This is actually correct behavior — no session is needed for the config-check/CLI-check/language-check early exits. No session leak risk.

**FINDING F-02 (MEDIUM): Session not closed if `matchFindings` or `loadCodeQLFindings` throws and the outer catch fires.** Looking more carefully: the inner `try { ... } finally { session.close() }` at lines 204-242 IS inside the outer try/catch at line 83. If `matchFindings` throws, the `finally` at 241 runs first (closing the session), then the error propagates to the outer catch at 243. This is correct — JavaScript `finally` blocks execute before the error propagates to an outer catch. **No issue.**

### Does it always clean up CodeQL databases from disk?

**PASS.** Each language's DB is cleaned up immediately after its loop iteration:
- DB creation fails: cleanup at line 142
- Analysis fails: cleanup at line 161
- After SARIF parsing (success or failure): cleanup at line 181

**FINDING F-03 (LOW): SARIF files are not cleaned up.** The runner writes SARIF files to `{tempDir}/codeql-jobs/{jobId}/{lang}-results.sarif` but only the DB directories are cleaned up. The SARIF files are small (KB range) but will accumulate. The entire `codeql-jobs/{jobId}/` directory should be cleaned up at the end. This is a minor resource leak, not a correctness issue.

### Does the purge-before-write pattern match the plan's Issue 2 fix?

**PASS.** The plan recommends Option A: "purge after parsing succeeds but before writing, so stale data only goes away when replacement data is ready." The loader implements exactly this — `loadCodeQLFindings` is only called after `matchFindings` succeeds (line 212), and the purge is the first operation inside the loader (line 164). If the orchestrator fails before reaching the loader (e.g., all SARIF parses fail), no purge occurs and old findings remain intact (per Flow 5 in the plan).

---

## Error Path Analysis

### Neo4j down during matching or loading?

**HANDLED.** If Neo4j is unreachable:
- `matchFindings` -> `session.run()` throws -> propagates to orchestrator's inner try block (line 204)
- `finally` block closes session (line 241)
- Error caught by outer catch (line 243), stats updated with "failed" status
- `node-matcher.ts` has per-location try/catch (line 56-65) that sets individual locations to null on query failure, but a full connection loss will likely throw on every query and eventually propagate

### Supabase down during stats update?

**HANDLED.** Two scenarios:
1. Normal path: `updateJobStats` throws -> caught by outer catch (line 243) -> attempts stats update again (line 263) -> if that also fails, caught by inner try/catch (lines 262-269), logged, result still returned
2. Error path: The nested try/catch around `updateJobStats` in the outer catch block (lines 262-269) prevents infinite error loops

**FINDING F-04 (LOW): Double stats-update attempt on Supabase failure.** If the initial `updateJobStats` call at line 238 fails (Supabase down), the error propagates to the outer catch which tries `updateJobStats` again at line 263. This is redundant but harmless — the second attempt will also fail and be caught silently.

### SARIF file doesn't exist?

**HANDLED.** `parseSarif` calls `readFile(filePath, "utf-8")` which throws `ENOENT`. This is caught by the per-language try/catch at line 172 in the orchestrator. The language is marked as failed, `anyFailed = true`, and the loop continues to the next language.

---

## Comparison with SCIP Pattern

The CodeQL orchestrator (`index.ts`) follows the SCIP orchestrator (`scip/index.ts`) pattern closely:
- Same `makeSkippedResult` helper pattern
- Same `anySuccess`/`anyFailed` tracking
- Same per-adapter loop with continue-on-failure
- Same `"partial"` status for mixed results
- CodeQL adds: session management (SCIP doesn't write to Neo4j directly), Supabase stats updates, disk cleanup

**FINDING F-05 (INFO): CodeQL adds "partial" status that's not in the original plan types.** The plan's `CodeQLStats.status` lists `"success" | "failed" | "skipped" | "timeout"` but `types.ts` line 31 correctly includes `"partial"`. The types file was updated to match the implementation. Good.

---

## Schema Compliance

### DataFlowFinding nodes (loader.ts lines 50-62)

| Plan Field | Implementation | Status |
|------------|---------------|--------|
| query_id | `f.query_id` | OK |
| severity | `f.severity` | OK |
| message | `f.message` | OK |
| source_path | `f.source_path` (formatted as `file:line`) | OK |
| sink_path | `f.sink_path` (formatted as `file:line`) | OK |
| repo_url | `$repoUrl` | OK |
| job_id | `$jobId` | OK |
| digest_id | **MISSING** | See F-06 |

**FINDING F-06 (LOW): `digest_id` field missing from DataFlowFinding nodes.** The plan (line 136) specifies `digest_id` as a property on `DataFlowFinding` nodes, but the loader only writes `job_id`. This is likely intentional since `job_id` is sufficient to trace back to the digest, but it deviates from the plan spec.

### FLOWS_TO edges (loader.ts lines 122-133)

| Plan Field | Implementation | Status |
|------------|---------------|--------|
| query_id | `e.query_id` (MERGE key) | OK |
| sink_kind | `e.sink_kind` (derived via `deriveSinkKind`) | OK |
| severity | `e.severity` | OK |
| message | `e.message` | OK |
| path_steps | `e.path_steps` (JSON string) | OK |
| path_complete | `e.path_complete` | OK |

**PASS.** FLOWS_TO edges use `MERGE` on `query_id` to deduplicate, with `SET` for other properties. `deriveSinkKind` is a nice addition not in the plan but useful for MCP tool filtering.

---

## Transaction Atomicity (Plan Issue 1)

**FINDING F-07 (MEDIUM): Purge and write are NOT in a single Neo4j transaction.** The plan's Issue 1 states: "Purge + write happen in a single Neo4j transaction." However, `loadCodeQLFindings` runs three separate `session.run()` calls (purge, write nodes, write edges) which each use auto-commit transactions. If the process crashes between purge and write-completion, the repo will have partial or no findings.

To fix, the loader should use an explicit transaction:
```typescript
const tx = session.beginTransaction();
try {
  await tx.run(purgeQuery, ...);
  await tx.run(writeNodesQuery, ...);
  await tx.run(writeEdgesQuery, ...);
  await tx.commit();
} catch (err) {
  await tx.rollback();
  throw err;
}
```

However, the batch loop (UNWIND with BATCH_SIZE=200) complicates single-transaction wrapping since multiple batches would need to be in the same transaction. This is a design tradeoff — the current approach is simpler but not atomic.

**Severity: MEDIUM** — A crash between purge and write-complete is unlikely but would leave the repo in a bad state until the next CodeQL run.

---

## Summary of Findings

| ID | Severity | Description |
|----|----------|-------------|
| F-01 | LOW | Session only created when needed (not a bug, verified correct) |
| F-02 | NONE | Session close in finally works correctly with nested try/catch |
| F-03 | LOW | SARIF temp files not cleaned up (minor disk leak) |
| F-04 | LOW | Redundant stats-update retry on Supabase failure (harmless) |
| F-05 | INFO | "partial" status correctly added to types beyond plan spec |
| F-06 | LOW | `digest_id` missing from DataFlowFinding nodes vs plan spec |
| F-07 | MEDIUM | Purge + write not in single Neo4j transaction (plan Issue 1 not fully implemented) |

## Verdict

**PASS.** Phase 3 implementation is solid. The orchestrator correctly chains all stages, handles partial success, never throws, always updates stats, and always closes the Neo4j session. The loader implements the Issue 2 fix correctly (purge only when replacement data is ready). The one medium finding (F-07: lack of transactional atomicity) is a known plan deviation that should be tracked for a future hardening pass but does not block Phase 4.
